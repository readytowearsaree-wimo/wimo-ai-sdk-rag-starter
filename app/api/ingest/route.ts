// app/api/ingest/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';
const { Client } = pkg;

// ─── Helpers ───────────────────────────────────────────────

function chunkText(text: string, maxLen = 4000) {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

async function fetchHtmlAsText(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,footer').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text;
}

async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  const res = await fetch(sitemapUrl, { cache: 'no-store' });
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  // handle sitemap index (links to sub-sitemaps)
  const sitemapLocs: string[] = [];
  $('sitemap > loc').each((_, el) => {
    sitemapLocs.push($(el).text().trim());
  });
  if (sitemapLocs.length > 0) return sitemapLocs;

  // handle URL set
  const pageUrls: string[] = [];
  $('url > loc').each((_, el) => {
    pageUrls.push($(el).text().trim());
  });
  return pageUrls;
}

// ─── Handlers ───────────────────────────────────────────────

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as any;

    // Secret check
    const headerSecret = req.headers.get('x-ingest-secret');
    const expectedSecret = process.env.INGEST_SECRET;
    if (expectedSecret && headerSecret !== expectedSecret) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const sitemapUrl: string | undefined =
      body.sitemapUrl || body.sitemapurl || body.sitemap || body.siteMapUrl;
    const singleUrl: string | undefined = body.url;
    const maxUrls: number = typeof body.maxUrls === 'number' ? body.maxUrls : 20;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json(
        { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // ─── Single URL mode ────────────────────────
    if (singleUrl) {
      const result = await ingestOneUrl(singleUrl, openai, client);
      await client.end();
      return NextResponse.json({
        mode: 'single',
        url: singleUrl,
        ...result,
      });
    }

    // ─── Sitemap mode ───────────────────────────
    if (sitemapUrl) {
      const urls = await fetchSitemapUrls(sitemapUrl);

      // If it's a sitemap index, return the subsites
      if (urls.length && urls[0].endsWith('.xml')) {
        await client.end();
        return NextResponse.json({
          ok: true,
          mode: 'sitemap-index',
          sitemapUrl,
          subSitemaps: urls,
          note: 'Call again with one of these sitemap URLs',
        });
      }

      // Otherwise it's a normal sitemap
      const limited = urls.slice(0, maxUrls);
      const ingested: string[] = [];
      const failed: { url: string; error: string }[] = [];

      for (const pageUrl of limited) {
        try {
          const r = await ingestOneUrl(pageUrl, openai, client);
          if (r.ok) ingested.push(pageUrl);
          else failed.push({ url: pageUrl, error: r.error || 'unknown' });
        } catch (e: any) {
          failed.push({ url: pageUrl, error: e?.message || String(e) });
        }
      }

      await client.end();
      return NextResponse.json({
        ok: true,
        mode: 'sitemap',
        sitemapUrl,
        countInThisRun: limited.length,
        ingested: ingested.length,
        failed,
        moreAvailable: urls.length > limited.length,
      });
    }

    await client.end();
    return NextResponse.json({ ok: false, error: 'No URL provided' }, { status: 400 });
  } catch (err: any) {
    console.error('Ingest error:', err);
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}

// ─── Core logic: ingest one page ───────────────────────────

async function ingestOneUrl(url: string, openai: OpenAI, client: any) {
  const text = await fetchHtmlAsText(url);
  if (!text) return { ok: false, error: 'No content extracted' };

  const docId = uuidv4();
  await client.query(
    `INSERT INTO documents (id, url, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (url) DO UPDATE SET content = excluded.content`,
    [docId, url, text]
  );

  await client.query(`DELETE FROM document_chunks WHERE document_id = $1`, [docId]);

  const chunks = chunkText(text);
  let idx = 0;
  for (const chunk of chunks) {
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: chunk,
    });
    const vector = emb.data[0].embedding;

    await client.query(
      `INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), docId, idx, chunk, vector]
    );
    idx++;
  }

  return { ok: true, chunks: chunks.length };
}
