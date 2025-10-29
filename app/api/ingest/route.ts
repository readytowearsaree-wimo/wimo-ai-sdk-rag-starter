// app/api/ingest/route.ts
import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';                // ✅ use namespace import (no default export)
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';
const { Client } = pkg;

// ---- helpers ----
export const runtime = 'nodejs';

function chunkText(text: string, maxLen = 4000) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
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

export function GET() {
  // simple health check + whether envs are present
  return NextResponse.json({
    ok: true,
    msg: 'ingest route is alive',
    hasEnv: !!process.env.SUPABASE_CONN && !!process.env.OPENAI_API_KEY,
  });
}

export async function POST(req: Request) {
  try {
    const { url } = await req.json();
    if (!url) {
      return NextResponse.json({ ok: false, error: 'No URL provided' }, { status: 400 });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN; // must include ?sslmode=require
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json({ ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' }, { status: 400 });
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // 1) fetch & clean text
    const text = await fetchHtmlAsText(url);
    if (!text) {
      await client.end();
      return NextResponse.json({ ok: false, error: 'No content extracted from URL' }, { status: 400 });
    }

    // 2) upsert into documents and get the actual id (important!)
    const newId = uuidv4();
    const upsert = await client.query(
      `insert into documents (id, url, content, meta)
       values ($1, $2, $3, $4)
       on conflict (url) do update set content = excluded.content, meta = excluded.meta
       returning id`,
      [newId, url, text, { source: 'web', ingested_at: new Date().toISOString() }]
    );
    const docId: string = upsert.rows[0].id;

    // 3) remove old chunks for this document
    await client.query(`delete from document_chunks where document_id = $1`, [docId]);

    // 4) chunk + embed + insert
    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const emb = await openai.embeddings.create({
        model: 'text-embedding-3-small',  // 1536 dims
        input: chunk,
      });

      const vector = emb.data[0].embedding;           // number[]
      const vectorStr = `[${vector.join(',')}]`;       // ✅ serialize for pgvector

      await client.query(
        `insert into document_chunks
           (id, document_id, chunk_index, content, embedding)
         values ($1, $2, $3, $4, $5::vector)`,         // ✅ cast to vector
        [uuidv4(), docId, i, chunk, vectorStr]
      );
    }

    await client.end();
    return NextResponse.json({ ok: true, message: 'Ingestion complete', url, chunks: chunks.length });
  } catch (err: any) {
    console.error('Ingest error:', err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
