import { NextResponse } from "next/server";
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

// --- Constants ---
const FAQ_MIN_SIM = 0.78;
const REVIEW_MIN_SIM = 0.70;
const MAX_RETURN = 3;
const REVIEW_GOOGLE_URL =
  "https://www.google.com/search?q=wimo+ready+to+wear+saree+reviews";

// --- Helpers ---
function normalize(str: string) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreReview(reviewText: string, query: string): number {
  const q = normalize(query).split(" ").filter(Boolean);
  const r = normalize(reviewText);
  let hits = 0;
  for (const word of q) {
    if (r.includes(word)) hits += 1;
  }
  return hits;
}

// --- Local reviews placeholder ---
const REVIEWS = [
  { text: "Loved the ready to wear saree! The fit and finishing were amazing.", date: "2025-10-21" },
  { text: "Excellent service, they even customized the saree to my measurements.", date: "2025-09-29" },
  { text: "Delivery was super quick and the saree draped beautifully!", date: "2025-09-15" },
  { text: "Very comfortable fabric. I’ll definitely buy again!", date: "2025-09-10" },
];

// --- CORS handler ---
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// --- GET route for sanity check ---
export async function GET() {
  return new Response(JSON.stringify({ ok: true, msg: "search route is alive" }), {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    },
  });
}

// --- POST route ---
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? "").toString().trim();
    const wantReviewsOnly = !!body?.showReviews;
    const topK = Math.min(Math.max(Number(body?.topK ?? 10), 1), 20);

    if (!query) {
      return new Response(JSON.stringify({ ok: false, error: "Missing 'query'" }), {
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return new Response(JSON.stringify({ ok: false, error: "Missing keys" }), {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Create embedding for query
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(",")}]`;

    // Connect to Supabase (Postgres)
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    const sql = `
      select
        dc.document_id,
        d.url,
        d.meta,
        dc.chunk_index,
        dc.content,
        1 - (dc.embedding <=> $1::vector) as similarity
      from document_chunks dc
      join documents d on d.id = dc.document_id
      where dc.embedding is not null
      order by dc.embedding <=> $1::vector
      limit $2;
    `;

    const { rows } = await client.query(sql, [vecLiteral, topK]);
    await client.end();

    const enriched = rows.map((r: any) => {
      const source =
        (r.meta && typeof r.meta === "object" && (r.meta.source || r.meta.type)) ||
        (r.url?.includes("google") ? "google-review" : "faq");
      return {
        document_id: r.document_id,
        url: r.url,
        source,
        chunk_index: r.chunk_index,
        content: r.content,
        similarity: Number(r.similarity),
      };
    });

    // --- CASE 1: User explicitly asked for reviews ---
    if (wantReviewsOnly) {
      const scored = REVIEWS.map((r) => ({
        ...r,
        __score: scoreReview(r.text, query),
        __date: r.date ? new Date(r.date).getTime() : 0,
      }))
        .filter((r) => r.__score > 0)
        .sort((a, b) =>
          b.__score !== a.__score ? b.__score - a.__score : b.__date - a.__date
        );

      const topReviews = scored.slice(0, MAX_RETURN);
      return new Response(
        JSON.stringify({
          ok: true,
          query,
          source: "google-review",
          results: topReviews.map((r) => ({ content: r.text, date: r.date })),
          reviewLink: REVIEW_GOOGLE_URL,
        }),
        {
          status: 200,
          headers: { "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    // --- CASE 2: FAQ-FIRST ---
    const faqHits = enriched
      .filter((r: any) => r.source === "faq" && r.similarity >= FAQ_MIN_SIM)
      .slice(0, MAX_RETURN);

    if (faqHits.length > 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          query,
          source: "faq",
          results: faqHits.map((r) => ({
            content: r.content,
            similarity: r.similarity,
          })),
          canShowReviews: true,
        }),
        {
          status: 200,
          headers: { "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    // --- CASE 3: fallback to reviews if no FAQ found ---
    const scored = REVIEWS.map((r) => ({
      ...r,
      __score: scoreReview(r.text, query),
      __date: r.date ? new Date(r.date).getTime() : 0,
    }))
      .filter((r) => r.__score > 0)
      .sort((a, b) =>
        b.__score !== a.__score ? b.__score - a.__score : b.__date - a.__date
      );

    const topReviews = scored.slice(0, MAX_RETURN);
    if (topReviews.length > 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          query,
          source: "google-review",
          results: topReviews.map((r) => ({ content: r.text, date: r.date })),
          reviewLink: REVIEW_GOOGLE_URL,
        }),
        {
          status: 200,
          headers: { "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    // --- CASE 4: none found ---
    return new Response(
      JSON.stringify({
        ok: true,
        query,
        source: "none",
        results: [],
        message: "I couldn’t find this in FAQs or reviews.",
      }),
      {
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
      }
    );
  } catch (err: any) {
    console.error("Search error:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), {
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
}
