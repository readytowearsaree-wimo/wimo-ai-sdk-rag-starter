export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { JSDOM } from 'jsdom'; // optional fallback if cheerio fails; we won't import by default
import cheerio from 'cheerio';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { parseStringPromise } from 'xml2js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const pool = new Pool({ connectionString: process.env.SUPABASE_CONN });

/** --- helpers --- */
function cleanText(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function chunkText(text: string, chunkSize = 1500, overlap = 200): string[] {
  // naive char-based chunker (fine for first pass)
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + chunkSize, text.length);
    const slice = text.slice(i, end);
    chunks.push(slice);
    i += chunkSize - overlap;
  }
  return chunks.filter(c => c.trim().length > 0);
}

async function fetchAndExtract(url: string): Promise<{ title: string; content: string }> {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (ingest-bot)' } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}`);
  const html = await res.text();

  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const title = cleanText($('title').first().text() || '');
  const bodyText = cleanText($('body').text() || '');
  return { title, content: bodyText };
}

async function embedChunks(chunks: string[]) {
  // text-embedding-3-small (1536 dims) is cheap and good
  const resp = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: chunks,
  });
  return resp.data.map(d => d.embedding);
}

async function upsertDocument(url: string, title: string, content: string) {
  const client = await pool.connect();
  try {
    const id = uuidv4();
    // upsert by URL
    const { rows } = await client.query(
      `insert into documents (id, url, title, content)
       values ($1, $2, $3, $4)
       on conflict (url) do update set
         title = excluded.title,
         content = excluded.content
       returning id, url;`,
      [id, url, title, content]
    );
    return rows[0].id as string;
  } finally {
    client.release();
  }
}

async function insertChunks(documentId: string, chunks: string[], embeddings: number[][]) {
  const client = await pool.connect();
  try {
    const valuesSql = chunks
      .map((_, i) => `($1, ${i}, $${i + 2}, $${i + 2 + chunks.length}::vector)`)
      .join(',\n');

    const texts = chunks;                                  // $2 .. $(1+chunks.length)
    const vecsAsStrings = embeddings.map(e => `[${e.join(',')}]`); // $(2+chunks.length) .. $(1+2*chunks.length)

    await client.query(
      `insert into document_chunks (document_id, chunk_index, content, embedding)
       values ${valuesSql}`,
      [documentId, ...texts, ...vecsAsStrings]
    );
  } finally {
    client.release();
  }
}

async function ingestOne(url: string) {
  const { title, content } = await fetchAndExtract(url);
  if (!content || content.length < 100) {
    return { url, skipped: true, reason: 'too-short' };
  }
  const chunks = chunkText(content, 1500, 200);
  const embeddings = await embedChunks(chunks);
  const docId = await upsertDocument(url, title, content);
  await insertChunks(docId, chunks, embeddings);
  return { url, ok: true, chunks: chunks.length };
}

/** --- route handlers --- */
export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

type Body = { url?: string; sitemap?: string };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    if (body.url) {
      const r = await ingestOne(body.url);
      return NextResponse.json(r);
    }

    if (body.sitemap) {
      // fetch sitemap XML, extract <loc> urls, ingest each (limit first 50 to be safe)
      const xml = await (await fetch(body.sitemap)).text();
      const parsed = await parseStringPromise(xml);
      const locs: string[] =
        parsed?.urlset?.url?.map((u: any) => u.loc?.[0]).filter(Boolean) ?? [];

      const toIngest = locs.slice(0, 50);
      const results = [];
      for (const u of toIngest) {
        try {
          results.push(await ingestOne(u));
        } catch (err: any) {
          results.push({ url: u, ok: false, error: err?.message || 'failed' });
        }
      }
      return NextResponse.json({ ok: true, count: results.length, results });
    }

    return NextResponse.json({ ok: false, error: 'Provide {url} or {sitemap}' }, { status: 400 });
  } catch (err: any) {
    console.error('INGEST ERROR', err);
    return NextResponse.json({ ok: false, error: err?.message || 'unknown' }, { status: 500 });
  }
}
