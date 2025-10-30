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
    const content: string = r.content ?? '';
    const baseScore = Number(r.similarity) || 0;

    // 1) URL-based bucket
    let bucket = classifyUrl(url);

    // 2) content-based override for FAQ
    // if the content itself looks like a Q&A, treat it as FAQ even if URL is ugly
    const lowerContent = content.toLowerCase();
    const looksLikeFaq =
      lowerContent.startsWith('q:') ||
      lowerContent.includes('question:') ||
      lowerContent.includes('answer:') ||
      lowerContent.includes('ready to wear saree') && lowerContent.includes('how') ||
      lowerContent.includes('can i ') ||
      lowerContent.includes('do you ') ||
      lowerContent.includes('what is ') ||
      lowerContent.includes('how do i ');

    if (looksLikeFaq && bucket === 'other') {
      bucket = 'faq';
    }

    let boosted = baseScore;

    // site-wide priority
    switch (bucket) {
      case 'faq':
        boosted += 0.30;
        break;
      case 'product':
        boosted += 0.15;
        break;
      case 'policy':
        boosted += 0.05;
        break;
    }

    // ---- query-aware boosts ----
    // we already computed these above:
    // const { wantsShipping, wantsCOD, wantsReturn } = detectIntent(query);

    const u = url.toLowerCase();

    // shipping: by URL OR by content
    if (wantsShipping) {
      const contentSaysShipping =
        lowerContent.includes('ship') ||
        lowerContent.includes('shipping') ||
        lowerContent.includes('international') ||
        lowerContent.includes('deliver');

      if (
        u.includes('/shipping') ||
        u.includes('/s/f/do-you-ship') ||
        u.includes('international') ||
        contentSaysShipping
      ) {
        boosted += 0.35;
      }
    }

    // COD: by URL OR content
    if (wantsCOD) {
      const contentSaysCOD =
        lowerContent.includes('cod') ||
        lowerContent.includes('cash on delivery');
      if (
        u.includes('cod') ||
        u.includes('cash-on-delivery') ||
        u.includes('/s/f/do-you-offer-cash-on') ||
        contentSaysCOD
      ) {
        boosted += 0.35;
      }
    }

    // return/refund: by URL OR content
    if (wantsReturn) {
      const contentSaysReturn =
        lowerContent.includes('return') ||
        lowerContent.includes('refund') ||
        lowerContent.includes('exchange');
      if (
        u.includes('/return') ||
        u.includes('/cancellation') ||
        u.includes('/refund') ||
        u.includes('/s/f/what-s-the-return') ||
        u.includes('/s/f/what-is-your-returns') ||
        contentSaysReturn
      ) {
        boosted += 0.35;
      }
    }

    return {
      bucket,
      boostedScore: boosted,
      document_id: r.document_id,
      url,
      chunk_index: r.chunk_index,
      content: r.content,
      original_similarity: baseScore,
    };
  })
  .sort((a, b) => b.boostedScore - a.boostedScore)
  .slice(0, topK);

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
