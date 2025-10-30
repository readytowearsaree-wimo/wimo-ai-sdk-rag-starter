// app/api/search/route.ts
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import pkg from 'pg';

const { Client } = pkg;

// helper: assign weights based on URL patterns
function pagePriority(url: string) {
  if (!url) return 0;
  const u = url.toLowerCase();

  // FAQ first, then Product, then Policy
  if (u.includes('faq')) return 3;
  if (u.includes('/products/') || u.includes('stitch')) return 2;
  if (u.includes('policy') || u.includes('terms')) return 1;
  return 0;
}

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

    // 1️⃣ Embed the user query
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(',')}]`;

    // 2️⃣ Run vector similarity search in Supabase
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

    const { rows } = await client.query(sql, [vecLiteral, topK]);
    await client.end();

    // 3️⃣ Apply priority boosting based on URL
    const boosted = rows
      .map((r) => {
        const base = Number(r.similarity) || 0;
        const bonus = pagePriority(r.url) * 0.05; // boost size: 0.05 per tier
        return {
          document_id: r.document_id,
          url: r.url,
          chunk_index: r.chunk_index,
          content: r.content,
          similarity: base,
          boostedScore: base + bonus,
        };
      })
      .sort((a, b) => b.boostedScore - a.boostedScore);

    // 4️⃣ Return the re-ranked results
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
