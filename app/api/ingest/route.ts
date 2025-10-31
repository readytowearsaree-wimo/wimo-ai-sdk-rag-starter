// app/api/ingest/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';

const { Client } = pkg;

// tiny helper to make an id for “content-only” docs
function makeDocId() {
  return uuidv4();
}

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as any;

    // 1) secret check
    const incoming = req.headers.get('x-ingest-secret') || '';
    const expected = process.env.INGEST_SECRET || '';
    if (expected && incoming !== expected) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    // we are in “content-only” mode now
    const content = (body.content || '').toString().trim();
    const sourceBucket = (body.sourceBucket || 'faq').toString();

    if (!content) {
      return NextResponse.json({ ok: false, error: 'no content provided' }, { status: 400 });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json(
        { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // 2) embed the content
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: content,
    });
    const vector: number[] = emb.data[0].embedding;

    // 🔴 IMPORTANT: turn JS array -> pgvector literal
    const embeddingLiteral = `[${vector.join(',')}]`;

    // 3) connect to db
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // 4) make a doc row
    const docId = makeDocId();
    await client.query(
      `
      insert into documents (id, url, content, meta)
      values ($1, $2, $3, $4)
      `,
      [
        docId,
        // no real url, so store a synthetic one
        `faq://${docId}`,
        content,
        { source: sourceBucket },
      ]
    );

    // 5) make chunk row (single chunk for faq)
    await client.query(
      `
      insert into document_chunks (id, document_id, chunk_index, content, embedding)
      values ($1, $2, $3, $4, $5::vector)
      `,
      [
        uuidv4(),
        docId,
        0,
        content,
        embeddingLiteral, // 👈 now it’s a string like "[0.1,0.2,...]" not a JS array
      ]
    );

    await client.end();

    return NextResponse.json({
      ok: true,
      message: 'FAQ ingestion complete',
      sourceBucket,
    });
  } catch (err: any) {
    console.error('Ingest error:', err);
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
