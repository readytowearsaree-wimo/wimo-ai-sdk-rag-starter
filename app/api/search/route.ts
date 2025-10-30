// app/api/search/route.ts
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import pkg from 'pg';

const { Client } = pkg;

// we’ll over-fetch from DB, then re-rank in code
const DB_FETCH_LIMIT = 30;

// simple helper: decide which bucket a URL belongs to
function classifyUrl(url: string): 'faq' | 'product' | 'policy' | 'other' {
  const u = url.toLowerCase();

  // 1) FAQs (your priority 1)
  if (
    u.includes('/s/f/') ||                  // all the wix FAQ single pages
    u.includes('/faqs-for-ready-to-wear-saree') ||
    u.includes('/faq')                      // fallback
  ) {
    return 'faq';
  }

  // 2) Products / categories (priority 2)
  if (
    u.includes('/products/') ||
    u.includes('/category/') ||
    u.includes('/wimo-ready-to-wear-sarees-international-site')
  ) {
    return 'product';
  }

  // 3) Policy pages (priority 3)
  if (
    u.includes('/shipping') ||
    u.includes('/return') ||
    u.includes('/refund') ||
    u.includes('/cancellation')
  ) {
    return 'policy';
  }

  return 'other';
}

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'search route is alive' });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? '').toString().trim();
    // user wants 5 usually, cap at 20
    const topK = Math.min(Math.max(Number(body?.topK ?? 5), 1), 20);

    if (!query) {
      return NextResponse.json({ ok: false, error: 'Missing "query"' }, { status: 400 });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json(
        { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
        { status: 500 },
      );
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // 1) embed the user query
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding; // number[]

    // pgvector literal
    const vecLiteral = `[${queryEmbedding.join(',')}]`;

    // 2) fetch candidates from Postgres
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

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

    const { rows } = await client.query(sql, [vecLiteral, DB_FETCH_LIMIT]);
    await client.end();

    // 3) re-rank in code according to your priority:
    //    faq > product > policy > other
    const reranked = rows
      .map((r) => {
        const url: string = r.url ?? '';
        const bucket = classifyUrl(url);
        const baseScore = Number(r.similarity) || 0;

        // BOOSTS: tune here
        let boostedScore = baseScore;
        switch (bucket) {
          case 'faq':
            boostedScore += 0.30; // biggest boost
            break;
          case 'product':
            boostedScore += 0.15;
            break;
          case 'policy':
            boostedScore += 0.05;
            break;
          default:
            // 'other' -> no boost
            break;
        }

        return {
          bucket,
          boostedScore,
          document_id: r.document_id,
          url,
          chunk_index: r.chunk_index,
          content: r.content,
          original_similarity: baseScore,
        };
      })
      // sort by boosted score desc
      .sort((a, b) => b.boostedScore - a.boostedScore)
      // return only what the user asked for
      .slice(0, topK);

    return NextResponse.json({
      ok: true,
      query,
      results: reranked.map((r) => ({
        document_id: r.document_id,
        url: r.url,
        chunk_index: r.chunk_index,
        content: r.content,
        similarity: r.original_similarity,
        boostedScore: r.boostedScore,
        sourceBucket: r.bucket,
      })),
    });
  } catch (err: any) {
    console.error('Search error:', err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
