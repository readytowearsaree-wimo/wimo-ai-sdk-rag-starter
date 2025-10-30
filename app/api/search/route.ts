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
      return NextResponse.json({ ok: false, error: 'Missing "query"' }, { status: 400 });
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

    // 1) embed user query
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(',')}]`;

    // 2) fetch more than we finally need (to give FAQ a chance)
    //    we'll re-rank in Node
    const fetchCount = Math.max(topK * 3, 30); // gets 30 rows max

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

    const { rows } = await client.query(sql, [vecLiteral, fetchCount]);
    await client.end();

    // 3) re-rank with "FAQ first if comparable"
    const results = rows
      .map(r => {
        const url: string = r.url || '';
        const isFaq =
          url.includes('/s/f/') ||
          url.includes('/faqs-for-ready-to-wear-saree') ||
          url.includes('/faq') ||
          url.includes('/faqs');

        // base score from vector
        const base = Number(r.similarity) || 0;

        // generic FAQ bonus: enough to win in a tie,
        // but not enough to beat a clearly better non-FAQ match
        const faqBonus = isFaq ? 0.25 : 0;

        return {
          document_id: r.document_id,
          url: r.url,
          chunk_index: r.chunk_index,
          content: r.content,
          similarity: base,
          boostedScore: base + faqBonus,
          sourceBucket: isFaq ? 'faq' : 'other',
        };
      })
      // sort by boosted score desc
      .sort((a, b) => b.boostedScore - a.boostedScore)
      // finally return only what user asked for
      .slice(0, topK);

    return NextResponse.json({
      ok: true,
      query,
      results,
    });
  } catch (err: any) {
    console.error('Search error:', err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
