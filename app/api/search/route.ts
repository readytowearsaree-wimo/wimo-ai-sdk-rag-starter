// app/api/search/route.ts
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import pkg from 'pg';

const { Client } = pkg;

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'search route is alive' });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? '').toString().trim();
    const topK = Math.min(Math.max(Number(body?.topK ?? 5), 1), 20);

    if (!query) {
      return NextResponse.json(
        { ok: false, error: 'Missing "query"' },
        { status: 400 }
      );
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json(
        { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
        { status: 500 }
      );
    }

    // 1) embed query
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(',')}]`;

    // 2) fetch from pg
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // pull MORE than we need so we can re-rank in JS
    const candidateLimit = Math.max(topK * 4, 20);

    const sql = `
      select
        dc.document_id,
        d.url,
        dc.chunk_index,
        dc.content,
        1 - (dc.embedding <=> $1::vector) as similarity
      from document_chunks dc
      join documents d on d.id = dc.document_id
      order by dc.embedding <=> $1::vector
      limit $2;
    `;

    const { rows } = await client.query(sql, [vecLiteral, candidateLimit]);
    await client.end();

    // 3) JS re-rank with buckets
    // priority:
    // 1. FAQ pages       -> +0.30
    // 2. Product pages   -> +0.15
    // 3. Policy pages    -> +0.05
    // else               -> 0
    const reranked = rows
      .map((r: any) => {
        const url: string = r.url ?? '';
        let boost = 0;

        const isFaq =
          url.includes('/faqs') ||
          url.includes('/s/f/') ||
          url.includes('/faq');
        const isProduct =
          url.includes('/products/') ||
          url.includes('/category/');
        const isPolicy =
          url.includes('/shipping') ||
          url.includes('/return') ||
          url.includes('/cancellation');

        if (isFaq) {
          boost = 0.30;
        } else if (isProduct) {
          boost = 0.15;
        } else if (isPolicy) {
          boost = 0.05;
        }

        const baseSim = Number(r.similarity);
        const boostedScore = baseSim + boost;

        return {
          document_id: r.document_id,
          url,
          chunk_index: r.chunk_index,
          content: r.content,
          similarity: baseSim,
          boost,
          boostedScore,
        };
      })
      // sort by boosted score first
      .sort((a, b) => b.boostedScore - a.boostedScore)
      // then take what user asked for
      .slice(0, topK);

    return NextResponse.json({
      ok: true,
      query,
      results: reranked,
    });
  } catch (err: any) {
    console.error('Search error:', err);
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
