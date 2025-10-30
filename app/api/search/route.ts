// app/api/search/route.ts
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import pkg from 'pg';

const { Client } = pkg;

// put your FAQ url(s) here
const FAQ_URLS = [
  'https://www.readytowearsaree.com/faqs-for-ready-to-wear-saree',
];

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'search route is alive' });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? '').toString().trim();
    // user asked for 5, but we’ll pull more from DB and re-rank
    const userTopK = Math.min(Math.max(Number(body?.topK ?? 5), 1), 20);
    const dbTopK = Math.max(userTopK, 20); // fetch more to re-rank

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

    // 1) embed query
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(',')}]`;

    // 2) query pg
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
    const { rows } = await client.query(sql, [vecLiteral, dbTopK]);
    await client.end();

    // 3) re-rank in JS
    const boosted = rows
      .map((r: any) => {
        let boost = 1.0;

        const url: string = r.url || '';

        // boost FAQ page
        if (FAQ_URLS.some(f => url.startsWith(f))) {
          boost *= 1.4; // play with this value
        }

        // de-prioritize policy pages a bit
        if (
          url.includes('/shipping') ||
          url.includes('/polic') || // shipping-policy, cancellation-policy
          url.includes('/cancellation')
        ) {
          boost *= 0.9;
        }

        return {
          document_id: r.document_id,
          url: url,
          chunk_index: r.chunk_index,
          content: r.content,
          similarity: Number(r.similarity) * boost,
          _rawSim: Number(r.similarity),
        };
      })
      // sort by boosted similarity DESC
      .sort((a, b) => b.similarity - a.similarity)
      // finally trim to what user asked
      .slice(0, userTopK);

    return NextResponse.json({
      ok: true,
      query,
      results: boosted,
    });
  } catch (err: any) {
    console.error('Search error:', err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
