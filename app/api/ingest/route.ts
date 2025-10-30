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

async function fetchHtmlAsText(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,footer').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text;
}

// health check
export async function GET() {
  return NextResponse.json({
    ok: true,
    msg: 'ingest route is alive',
    hasDb: !!process.env.SUPABASE_CONN,
  });
}

export async function POST(req: Request) {
  try {
    // 1) auth header (optional but you were using it)
    const expectedSecret = process.env.INGEST_SECRET;
    if (expectedSecret) {
      const got = req.headers.get('x-ingest-secret');
      if (got !== expectedSecret) {
        return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
    }

    const body = (await req.json().catch(() => ({}))) as any;
    const url = body.url;
    if (!url) {
      return NextResponse.json({ ok: false, error: 'No URL provided' }, { status: 400 });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json(
        { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
        { status: 500 }
      );
    }

    // 2) connect
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // 3) fetch page
    const text = await fetchHtmlAsText(url);
    if (!text) {
      await client.end();
      return NextResponse.json({ ok: false, error: 'Could not extract text' }, { status: 400 });
    }

    // 4) insert / upsert document
    const docId = uuidv4();
    await client.query(
      `
      INSERT INTO documents (id, url, content)
      VALUES ($1, $2, $3)
      ON CONFLICT (url) DO UPDATE SET content = EXCLUDED.content
      `,
      [docId, url, text]
    );

    // 5) delete old chunks for this doc (we're re-ingesting)
    await client.query(`DELETE FROM document_chunks WHERE document_id = $1`, [docId]);

    // 6) chunk + embed + insert
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const chunks = chunkText(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const emb = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk,
      });

      const vector = emb.data[0].embedding; // JS number[]
      // 👇 turn JS array into pgvector text: [0.1,0.2,...]
      const vecStr = `[${vector.join(',')}]`;

      await client.query(
        `
        INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding)
        VALUES ($1, $2, $3, $4, $5::vector)
        `,
        [uuidv4(), docId, i, chunk, vecStr]
      );
    }

    await client.end();

    return NextResponse.json({
      ok: true,
      mode: 'single',
      url,
      chunks: chunks.length,
    });
  } catch (err: any) {
    console.error('ingest error:', err);
    return NextResponse.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
