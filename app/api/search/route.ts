// app/api/search/route.ts
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import pkg from 'pg';

const { Client } = pkg;

// 1) CORS helper
const ALLOWED_ORIGIN = 'https://www.readytowearsaree.com';

function cors(res: NextResponse) {
  res.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  res.headers.set('Access-Control-Max-Age', '86400');
  return res;
}

// 2) handle preflight
export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

// simple ping
export async function GET() {
  return cors(NextResponse.json({ ok: true, msg: 'search route alive' }));
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? '').toString().trim();
    const topK = Math.min(Math.max(Number(body?.topK ?? 5), 1), 20);

    if (!query) {
      return cors(
        NextResponse.json({ ok: false, error: 'Missing "query"' }, { status: 400 })
      );
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return cors(
        NextResponse.json(
          { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
          { status: 500 }
        )
      );
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // make embedding
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(',')}]`;

    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // fetch a few more so we can re-rank (faqs > products > policy)
    const sql = `
      select
        dc.document_id,
        d.url,
        d.meta,
        dc.chunk_index,
        dc.content,
        d.meta->>'sourceBucket' as sourceBucket,
        1 - (dc.embedding <=> $1::vector) as similarity
      from document_chunks dc
      join documents d on d.id = dc.document_id
      order by dc.embedding <=> $1::vector
      limit $2;
    `;

    const baseLimit = Math.max(topK, 10); // grab at least 10 to re-rank
    const { rows } = await client.query(sql, [vecLiteral, baseLimit]);
    await client.end();

    // re-rank: faq highest
    const boosted = rows
      .map((r: any) => {
        let bucket = (r.sourcebucket || r.sourceBucket || '').toLowerCase();
        let boost = 0;
        if (bucket === 'faq') boost = 0.35;
        else if (bucket === 'product') boost = 0.15;
        // else policy 0
        return {
          ...r,
          boostedScore: Number(r.similarity) + boost,
        };
      })
      .sort((a: any, b: any) => b.boostedScore - a.boostedScore)
      .slice(0, topK);

    const resp = {
      ok: true,
      query,
      results: boosted.map((r: any) => {
        // strip leading Q:/A:
        let clean = (r.content || '').replace(/^Q:\s*/i, '').replace(/^A:\s*/i, '');
        return {
          document_id: r.document_id,
          url: r.url,
          sourceBucket: r.sourcebucket || r.sourceBucket || null,
          content: clean,
          similarity: Number(r.similarity),
          boostedScore: Number(r.boostedScore),
        };
      }),
    };

    return cors(NextResponse.json(resp));
  } catch (err: any) {
    console.error('Search error:', err);
    return cors(
      NextResponse.json(
        { ok: false, error: err?.message || String(err) },
        { status: 500 }
      )
    );
  }
}
