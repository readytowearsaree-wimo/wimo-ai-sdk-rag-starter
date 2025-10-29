// app/api/ingest/route.ts
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

import cheerio from 'cheerio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';

const { Client } = pkg;

// -------- helpers --------
function chunkText(text: string, maxLen = 3500) {
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
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,footer').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text;
}

// Small utility to ensure we fail fast if env is missing
function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// -------- GET: quick health check (also shows if env is loaded) --------
export async function GET() {
  return NextResponse.json({
    ok: true,
    msg: 'ingest route is alive',
    hasSupabaseConn: !!process.env.SUPABASE_CONN,
  });
}

// -------- POST: ingest a single URL --------
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const url = body?.url as string | undefined;

    if (!url) {
      return NextResponse.json(
        { ok: false, error: 'No URL provided. Send JSON: { "url": "https://..." }' },
        { status: 400 }
      );
    }

    const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY');
    const SUPABASE_CONN = requireEnv('SUPABASE_CONN');

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const client = new Client({ connectionString: SUPABASE_CONN });

    await client.connect();

    // 1) fetch and clean page text
    const text = await fetchHtmlAsText(url);
    if (!text) {
      await client.end();
      return NextResponse.json({ ok: false, error: 'No text extracted from page' }, { status: 422 });
    }

    // 2) upsert into documents and get the id
    const upsert = await client.query(
      `
      insert into documents (id, url, content, meta)
      values ($1, $2, $3, $4)
      on conflict (url)
        do update set content = excluded.content, meta = excluded.meta, updated_at = now()
      returning id;
      `,
      [uuidv4(), url, text, { source: 'web', ingested_at: new Date().toISOString() }]
    );
    const docId: string = upsert.rows[0].id;

    // 3) remove old chunks for this doc id (fresh re-index)
    await client.query(`delete from document_chunks where document_id = $1`, [docId]);

    // 4) chunk, embed, and insert
    const chunks = chunkText(text);
    let inserted = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const emb = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk,
      });

      const vector = emb.data[0].embedding; // number[]

      await client.query(
        `
        insert into document_chunks (id, document_id, chunk_index, content, embedding)
        values ($1, $2, $3, $4, $5::vector)
        `,
        [uuidv4(), docId, i, chunk, vector]
      );
      inserted++;
    }

    await client.end();

    return NextResponse.json({
      ok: true,
      message: 'Ingestion complete',
      url,
      document_id: docId,
      chunks: inserted,
    });
  } catch (err: any) {
    console.error('Ingest error:', err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
