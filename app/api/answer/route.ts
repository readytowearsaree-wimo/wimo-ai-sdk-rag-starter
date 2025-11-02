// app/api/answer/route.ts
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import pkg from 'pg';

const { Client } = pkg;

const FAQ_MIN_SIM = 0.78;
const MAX_FAQ_RETURN = 3;
const MAX_REVIEW_RETURN = 3;
const REVIEW_GOOGLE_URL =
  'https://www.google.com/search?q=wimo+ready+to+wear+saree+reviews';

// quick helper – light keyword scoring for reviews (since review embeddings are still null)
function normalize(str: string) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreText(text: string, query: string) {
  const qWords = normalize(query).split(' ').filter(Boolean);
  const t = normalize(text);
  let hits = 0;
  for (const w of qWords) {
    if (t.includes(w)) hits++;
  }
  return hits;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? '').toString().trim();
    const wantReviewsOnly = !!body?.showReviews;

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
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // ⬇️ get embedding for user query
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(',')}]`;

    // --------------------------------------------------
    // CASE A: user explicitly said "showReviews"
    // --------------------------------------------------
    if (wantReviewsOnly) {
      // try to get reviews from DB
      // remember: review chunks currently have NULL embedding, so we do text match + recency
      const { rows: reviewRows } = await client.query(
        `
        SELECT
          dc.content,
          d.url,
          d.meta,
          d.created_at
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        WHERE (d.meta->>'source') = 'google-review'
          AND dc.content ILIKE '%' || $1 || '%'
        ORDER BY d.created_at DESC
        LIMIT 30;
        `,
        [query],
      );

      // fallback: just take latest if no text match
      let ranked = reviewRows;
      if (reviewRows.length > 0) {
        ranked = reviewRows
          .map((r: any) => ({
            ...r,
            _score: scoreText(r.content || '', query),
          }))
          .sort((a, b) => {
            if (b._score !== a._score) return b._score - a._score;
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          });
      }

      await client.end();

      const top = ranked.slice(0, MAX_REVIEW_RETURN).map((r: any) => ({
        content: r.content,
        source: 'google-review',
        link: REVIEW_GOOGLE_URL,
      }));

      return NextResponse.json({
        ok: true,
        query,
        source: 'google-review',
        results: top,
        reviewLink: REVIEW_GOOGLE_URL,
      });
    }

    // --------------------------------------------------
    // CASE B: normal chat → FAQ first
    // --------------------------------------------------
    const { rows } = await client.query(
      `
      SELECT
        dc.document_id,
        dc.content,
        dc.chunk_index,
        d.url,
        d.meta,
        1 - (dc.embedding <=> $1::vector) AS similarity
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
      ORDER BY dc.embedding <=> $1::vector
      LIMIT 20;
      `,
      [vecLiteral],
    );

    await client.end();

    // tag each row
    const enriched = rows.map((r: any) => {
      const src =
        (r.meta && typeof r.meta === 'object' && (r.meta.source || r.meta.type)) || 'faq';
      return {
        content: r.content,
        similarity: Number(r.similarity),
        source: src,
        url: r.url,
      };
    });

    // 1) take FAQ hits first
    const faqHits = enriched
      .filter((r) => r.source === 'faq' && r.similarity >= FAQ_MIN_SIM)
      .slice(0, MAX_FAQ_RETURN);

    if (faqHits.length > 0) {
      return NextResponse.json({
        ok: true,
        query,
        source: 'faq',
        results: faqHits.map((r) => ({
          content: r.content,
          similarity: r.similarity,
          source: 'faq',
        })),
        canShowReviews: true, // 👈 FE can now ask: "Do you want to see customer reviews related to this?"
      });
    }

    // 2) if no FAQ → try reviews directly
    return NextResponse.json({
      ok: true,
      query,
      source: 'none',
      results: [],
      canShowReviews: true, // still offer reviews
      message:
        'I could not find this in FAQs. Do you want to see what customers said about WiMO?',
    });
  } catch (err: any) {
    console.error('answer error:', err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
