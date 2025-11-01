// app/api/search/route.ts
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import pkg from 'pg';

const { Client } = pkg;

// allow your site + preview; if you want *, put '*'
const ALLOWED_ORIGINS = [
  'https://www.readytowearsaree.com',
  'https://readytowearsaree.com',
  'https://editor.wix.com',       // wix editor
  'https://manage.wix.com'        // wix preview
];

function cors(res: any, origin: string | null) {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  };
  // if you want to be lazy: headers['Access-Control-Allow-Origin'] = '*'
  headers['Access-Control-Allow-Origin'] =
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : '*';
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }
  return res;
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get('origin');
  const res = new NextResponse(null, { status: 204 });
  return cors(res, origin);
}

export async function GET(req: Request) {
  const origin = req.headers.get('origin');
  const res = NextResponse.json({ ok: true, msg: 'search route is alive' });
  return cors(res, origin);
}

export async function POST(req: Request) {
  const origin = req.headers.get('origin');

  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? '').toString().trim();
    const topK = Math.min(Math.max(Number(body?.topK ?? 5), 1), 20);

    if (!query) {
      const res = NextResponse.json(
        { ok: false, error: 'Missing "query"' },
        { status: 400 }
      );
      return cors(res, origin);
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      const res = NextResponse.json(
        { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
        { status: 500 }
      );
      return cors(res, origin);
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // embed user query
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(',')}]`;

    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    const sql = `
      select
        dc.document_id,
        d.url,
        dc.chunk_index,
        dc.content,
        dc."sourceBucket",
        1 - (dc.embedding <=> $1::vector) as similarity
      from document_chunks dc
      join documents d on d.id = dc.document_id
      order by dc.embedding <=> $1::vector
      limit $2;
    `;

    const { rows } = await client.query(sql, [vecLiteral, topK]);
    await client.end();

    const res = NextResponse.json({
      ok: true,
      query,
      results: rows.map((r: any) => ({
        document_id: r.document_id,
        url: r.url,
        chunk_index: r.chunk_index,
        content: r.content,
        sourceBucket: r.sourceBucket,
        similarity: Number(r.similarity)
      }))
    });

    return cors(res, origin);
  } catch (err: any) {
    console.error('Search error:', err);
    const res = NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
    return cors(res, origin);
  }
}
