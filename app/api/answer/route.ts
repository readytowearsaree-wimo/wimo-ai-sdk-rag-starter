// app/api/answer/route.ts
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import pkg from 'pg';

const { Client } = pkg;

// CORS helper
function withCors(res: NextResponse) {
  res.headers.set('Access-Control-Allow-Origin', '*'); // or 'https://www.readytowearsaree.com'
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  return res;
}

// handle preflight from Wix
export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }));
}

// simple health check for browser
export async function GET() {
  return withCors(
    NextResponse.json({ ok: true, msg: 'answer route is alive' })
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const message = (body.message ?? '').toString().trim();
    const topK = Math.min(Math.max(Number(body.topK ?? 5), 1), 20);

    if (!message) {
      return withCors(
        NextResponse.json({ ok: false, error: 'Missing "message"' }, { status: 400 })
      );
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return withCors(
        NextResponse.json(
          { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
          { status: 500 }
        )
      );
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // 1) embed user question
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: message,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(',')}]`;

    // 2) fetch top chunks (this is your FAQ-first query from before)
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();
    const sql = `
      with ranked as (
        select
          dc.document_id,
          d.url,
          dc.chunk_index,
          dc.content,
          coalesce(d.meta->>'sourceBucket','other') as source_bucket,
          1 - (dc.embedding <=> $1::vector) as similarity
        from document_chunks dc
        join documents d on d.id = dc.document_id
        order by dc.embedding <=> $1::vector
        limit 30
      )
      select *
      from ranked;
    `;
    const { rows } = await client.query(sql, [vecLiteral]);
    await client.end();

    // 3) boost FAQ
    const boosted = rows
      .map((r: any) => {
        const base = Number(r.similarity) || 0;
        const isFaq =
          r.source_bucket === 'faq' ||
          r.url?.startsWith('faq:') ||
          r.url?.includes('/s/f/');
        const bonus = isFaq ? 0.25 : 0; // FAQ wins
        return {
          ...r,
          boostedScore: base + bonus,
        };
      })
      .sort((a: any, b: any) => b.boostedScore - a.boostedScore)
      .slice(0, topK);

    const best = boosted[0];

    // 4) fall back if similarity is low
    const SIM_THRESHOLD = 0.55;
    if (!best || Number(best.boostedScore) < SIM_THRESHOLD) {
      return withCors(
        NextResponse.json({
          ok: true,
          from: 'fallback',
          answer:
            "I couldn't find this in WiMO FAQs right now. Please chat with us on WhatsApp: https://wa.me/919880625300",
        })
      );
    }

    // 5) normal answer
    return withCors(
      NextResponse.json({
        ok: true,
        from: 'faq',
        query: message,
        answer: best.content,
        source: {
          url: best.url,
          bucket: best.source_bucket,
          similarity: best.similarity,
          boosted: best.boostedScore,
        },
      })
    );
  } catch (err: any) {
    console.error('answer error:', err);
    return withCors(
      NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
    );
  }
}
