// app/api/ingest/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';
const { Client } = pkg;

// --- helpers ---
function chunkText(text: string, maxLen = 4000) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

async function fetchHtmlAsText(url: string) {
  const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script,style,noscript,iframe,nav,footer').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

export function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

export async function POST(req: Request) {
  try {
    const { url } = await req.json();
    if (!url) return NextResponse.json({ ok: false, error: 'No URL provided' }, { status: 400 });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json({ ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' }, { status: 400 });
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    const client = new Client({
      connectionString: SUPABASE_CONN,
      ssl: { rejectUnauthorized: false }, // safe for Supabase on Vercel
    });
    await client.connect();

    // 1) fetch & clean
    const text = await fetchHtmlAsText(url);
    if (!text || text.length < 50) throw new Error('No meaningful content extracted');

    // 2) upsert document and ALWAYS get the real id
    const upsert = await client.query(
      `
      insert into documents (id, url, content, meta)
      values ($1, $2, $3, $4)
      on conflict (url)
      do update set content = excluded.content, meta = excluded.meta
      returning id
      `,
      [uuidv4(), url, text, { source: 'web' }]
    );
    const docId: string = upsert.rows[0].id;

    // 3) wipe old chunks for this real doc id
    await client.query(`delete from document_chunks where document_id = $1`, [docId]);

    // 4) chunk + embed + insert
    const chunks = chunkText(text);
    let inserted = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const emb = await openai.embeddings.create({
        model: 'text-embedding-3-small', // 1536 dims
        input: chunk,
      });
      const vector = emb.data[0].embedding;

      await client.query(
        `
        insert into document_chunks (id, document_id, chunk_index, content, embedding)
        values ($1, $2, $3, $4, $5)
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
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
