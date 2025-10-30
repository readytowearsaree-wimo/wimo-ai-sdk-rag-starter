// app/api/ingest/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';
const { Client } = pkg;

// split long text into chunks
function chunkText(text: string, maxLen = 4000) {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

// fetch html → clean text
async function fetchHtmlAsText(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,footer').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text;
}

// simple GET healthcheck
export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

// single-url ingest
export async function POST(req: Request) {
  try {
    // 1) secret check
    const headerSecret = req.headers.get('x-ingest-secret');
    const expectedSecret = process.env.INGEST_SECRET;
    if (expectedSecret && headerSecret !== expectedSecret) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    // 2) body
    const body = (await req.json().catch(() => ({}))) as any;
    const url: string | undefined = body.url;
    if (!url) {
      return NextResponse.json({ ok: false, error: 'No URL provided' }, { status: 400 });
    }

    // 3) env
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json(
        { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
        { status: 500 }
      );
    }

    // 4) clients
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const client = new Client({
      connectionString: SUPABASE_CONN,
      ssl: { rejectUnauthorized: false }, // for Supabase on Vercel
    });
    await client.connect();

    // 5) fetch page
    const text = await fetchHtmlAsText(url);
    if (!text) {
      await client.end();
      return NextResponse.json({ ok: false, error: 'No content extracted from URL' });
    }

    // 6) upsert into documents (no meta column)
    const docId = uuidv4();
    await client.query(
      `INSERT INTO documents (id, url, content)
       VALUES ($1, $2, $3)
       ON CONFLICT (url) DO UPDATE SET content = excluded.content`,
      [docId, url, text]
    );

    // 7) delete old chunks for this doc
    await client.query(`DELETE FROM document_chunks WHERE document_id = $1`, [docId]);

    // 8) make chunks and embed
    const chunks = chunkText(text);
    let stored = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const emb = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk,
      });

      const vector = emb.data[0].embedding;

      await client.query(
        `INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), docId, i, chunk, vector]
      );
      stored++;
    }

    await client.end();

    return NextResponse.json({
      ok: true,
      message: 'Ingestion complete',
      url,
      chunks: chunks.length,
      stored,
    });
  } catch (err: any) {
    console.error('Ingest error:', err);
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}
