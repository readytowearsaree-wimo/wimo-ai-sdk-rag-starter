// app/api/ingest/route.ts
import { NextResponse } from 'next/server';
import cheerio from 'cheerio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';

const { Client } = pkg;

// helper: split large text into small chunks
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

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const url = body.url;
    if (!url) {
      return NextResponse.json({ ok: false, error: 'No URL provided' }, { status: 400 });
    }

    // environment setup
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json({ ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' }, { status: 400 });
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // fetch & clean text
    const text = await fetchHtmlAsText(url);
    if (!text) {
      return NextResponse.json({ ok: false, error: 'No content extracted from URL' });
    }

    // insert into documents table
    const docId = uuidv4();
    await client.query(
      `insert into documents (id, url, content, meta)
       values ($1, $2, $3, $4)
       on conflict (url) do update set content=excluded.content`,
      [docId, url, text, { source: 'web' }]
    );

    // remove old chunks for this document
    await client.query(`delete from document_chunks where document_id=$1`, [docId]);

    // generate embeddings
    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const emb = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk,
      });

      const vector = emb.data[0].embedding;
      await client.query(
        `insert into document_chunks (id, document_id, chunk_index, content, embedding)
         values ($1, $2, $3, $4, $5)`,
        [uuidv4(), docId, i, chunk, vector]
      );
    }

    await client.end();

    return NextResponse.json({
      ok: true,
      message: 'Ingestion complete',
      url,
      chunks: chunks.length,
    });
  } catch (err: any) {
    console.error('Ingest error:', err);
    return NextResponse.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
