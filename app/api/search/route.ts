// app/api/search/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

// thresholds
const FAQ_MIN_SIM = 0.78;
const MAX_RETURN = 3;
const REVIEW_GOOGLE_URL =
  "https://www.google.com/search?q=wimo+ready+to+wear+saree+reviews";

// helpers
function normalize(str: string) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreReview(reviewText: string, query: string): number {
  const qWords = normalize(query).split(" ").filter(Boolean);
  const r = normalize(reviewText);
  let hits = 0;
  for (const w of qWords) {
    if (r.includes(w)) hits += 1;
  }
  return hits;
}

export async function GET() {
  return NextResponse.json({ ok: true, msg: "search route is alive" });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? "").toString().trim();
    const wantReviewsOnly = !!body?.showReviews;
    const topK = Math.min(Math.max(Number(body?.topK ?? 10), 1), 20);

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
        { ok: false, error: "Missing OPENAI_API_KEY or SUPABASE_CONN" },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // ─────────────────────────────────────────
    // 1) embed user query (for FAQ vector search only)
    // ─────────────────────────────────────────
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(",")}]`;

    // helper: fetch reviews (NO vector, just by source)
    async function fetchReviewsFromDB(limit = 300) {
      const reviewsSql = `
        select
          dc.document_id,
          d.url,
          d.meta as doc_meta,
          dc.content,
          dc.created_at
        from document_chunks dc
        join documents d on d.id = dc.document_id
        where (d.meta->>'source') = 'google-review'
        order by dc.created_at desc
        limit $1;
      `;
      const { rows } = await client.query(reviewsSql, [limit]);
      return rows;
    }

    // ─────────────────────────────────────────
    // BRANCH A: user clicked "see related reviews"
    // ─────────────────────────────────────────
    if (wantReviewsOnly) {
      const reviewRows = await fetchReviewsFromDB();

      const ranked = reviewRows
        .map((r: any) => {
          const score = scoreReview(r.content || "", query);
          const ts = r.created_at ? new Date(r.created_at).getTime() : 0;
          return {
            content: r.content,
            date: r.created_at,
            score,
            ts,
          };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return b.ts - a.ts;
        })
        .slice(0, MAX_RETURN);

      await client.end();

      if (ranked.length > 0) {
        return NextResponse.json({
          ok: true,
          query,
          source: "review",
          results: ranked,
          reviewLink: REVIEW_GOOGLE_URL,
        });
      } else {
        return NextResponse.json({
          ok: true,
          query,
          source: "review",
          results: [],
          message:
            "I didn’t find a very close review for this, but you can see all our 4.8★ Google reviews here.",
          reviewLink: REVIEW_GOOGLE_URL,
        });
      }
    }

    // ─────────────────────────────────────────
    // 2) normal flow → do FAQ vector search
    // (remember: ONLY FAQ chunks have embeddings)
    // ─────────────────────────────────────────
    const faqSql = `
      select
        dc.document_id,
        d.url,
        d.meta as doc_meta,
        dc.chunk_index,
        dc.content,
        1 - (dc.embedding <=> $1::vector) as similarity
      from document_chunks dc
      join documents d on d.id = dc.document_id
      where dc.embedding is not null   -- ✅ ignore review chunks
      order by dc.embedding <=> $1::vector
      limit $2;
    `;

    const { rows } = await client.query(faqSql, [vecLiteral, topK]);

    // figure out source from documents.meta (because dc.meta is null)
    const enriched = rows.map((r: any) => {
      const source =
    (r.meta && typeof r.meta === 'object' && (r.meta.source || r.meta.type)) ||
    'faq';
      return {
        document_id: r.document_id,
        url: r.url,
        source,
        chunk_index: r.chunk_index,
        content: r.content,
        similarity: Number(r.similarity),
      };
    });

    const faqHits = enriched
      .filter((r) => r.source === "faq" && r.similarity >= FAQ_MIN_SIM)
      .slice(0, MAX_RETURN);

    if (faqHits.length > 0) {
      await client.end();
      return NextResponse.json({
        ok: true,
        query,
        source: "faq",
        results: faqHits.map((r) => ({
          content: r.content,
          similarity: r.similarity,
        })),
        canShowReviews: true, // 👈 frontend can now call again with showReviews:true
      });
    }

    // ─────────────────────────────────────────
    // 3) no FAQ match → try reviews now (NO vector)
    // ─────────────────────────────────────────
    const reviewRows = await fetchReviewsFromDB();
    const ranked = reviewRows
      .map((r: any) => {
        const score = scoreReview(r.content || "", query);
        const ts = r.created_at ? new Date(r.created_at).getTime() : 0;
        return {
          content: r.content,
          date: r.created_at,
          score,
          ts,
        };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.ts - a.ts;
      })
      .slice(0, MAX_RETURN);

    await client.end();

    if (ranked.length > 0) {
      return NextResponse.json({
        ok: true,
        query,
        source: "review",
        results: ranked,
        reviewLink: REVIEW_GOOGLE_URL,
      });
    }

    // ─────────────────────────────────────────
    // 4) absolutely nothing
    // ─────────────────────────────────────────
    return NextResponse.json({
      ok: true,
      query,
      source: "none",
      results: [],
      message:
        "I couldn’t find this in FAQs or reviews. Please chat with us on WhatsApp 👇",
    });
  } catch (err: any) {
    console.error("Search error:", err);
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
