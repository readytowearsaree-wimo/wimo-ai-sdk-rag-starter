// app/api/search/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

const FAQ_MIN_SIM = 0.55;
const MAX_RETURN = 3;
const REVIEW_GOOGLE_URL =
  "https://www.google.com/search?q=wimo+ready+to+wear+saree+reviews";

const ORDER_KEYWORDS = [
  "order",
  "delivery",
  "when will i get",
  "where is my order",
  "track my order",
  "status",
  "pickup",
  "courier",
  "delayed",
];

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

function parseReviewText(raw: string) {
  const out: {
    reviewer?: string;
    rating?: number;
    date?: string;
    review?: string;
    sourceUrl?: string;
    raw: string;
  } = { raw };

  if (!raw) return out;

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const low = line.toLowerCase();
    if (low.startsWith("reviewer:")) {
      out.reviewer = line.split(":").slice(1).join(":").trim();
    } else if (low.startsWith("rating:")) {
      const num = Number(line.replace(/rating:/i, "").trim());
      if (!Number.isNaN(num)) out.rating = num;
    } else if (low.startsWith("date:")) {
      out.date = line.replace(/date:/i, "").trim();
    } else if (low.startsWith("source:")) {
      out.sourceUrl = line.replace(/source:/i, "").trim();
    }
  }

  const reviewLine = lines.find(
    (l) => l.toLowerCase().startsWith("review:") || l.toLowerCase().startsWith("comment:")
  );
  if (reviewLine) {
    out.review = reviewLine.split(":").slice(1).join(":").trim();
  } else {
    out.review = raw.trim();
  }

  return out;
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    },
  });
}

// CORS preflight
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

export async function GET() {
  return json({ ok: true, msg: "search route is alive" }, 200);
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? "").toString().trim();
    const askDebug = !!body?.debug;

    if (!query) {
      return json({ ok: false, error: "Missing 'query'" }, 400);
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return json(
        { ok: false, error: "Missing OPENAI_API_KEY or SUPABASE_CONN" },
        500
      );
    }

    // 1) embed query
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(",")}]`;

    // 2) connect once
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // 2a) FAQs: rows that DO have embeddings
    const sqlFaq = `
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
      limit 50;
    `;
    const { rows: faqRows } = await client.query(sqlFaq, [vecLiteral]);

    // 2b) Reviews: rows that are google-review, EVEN IF embedding is null
    const sqlReviews = `
      select
        dc.document_id,
        d.url,
        d.meta,
        dc.chunk_index,
        dc.content,
        dc.created_at
      from document_chunks dc
      join documents d on d.id = dc.document_id
      where (d.meta->>'source') = 'google-review'
      order by dc.created_at desc
      limit 200;
    `;
    const { rows: reviewRows } = await client.query(sqlReviews);

    await client.end();

    // 3) FAQ logic
    let faqHits = faqRows
      .filter((r: any) => {
        const m = r.meta || {};
        const source =
          m.source || m.type || m.sourceBucket || "faq";
        return source === "faq" && Number(r.similarity) >= FAQ_MIN_SIM;
      })
      .slice(0, 3);

    // rescue order/delivery
    if (faqHits.length === 0) {
      const normQ = normalize(query);
      const looksLikeOrder = ORDER_KEYWORDS.some((kw) =>
        normQ.includes(kw)
      );
      if (looksLikeOrder) {
        const orderLike = faqRows
          .filter((r: any) => {
            const m = r.meta || {};
            const source = m.source || m.type || m.sourceBucket || "faq";
            return source === "faq";
          })
          .map((r: any) => {
            const score = ORDER_KEYWORDS.reduce((acc, kw) => {
              return acc + (normalize(r.content).includes(kw) ? 1 : 0);
            }, 0);
            return { ...r, orderScore: score };
          })
          .filter((r: any) => r.orderScore > 0)
          .sort((a: any, b: any) => b.orderScore - a.orderScore)
          .slice(0, 1);
        if (orderLike.length > 0) {
          faqHits = orderLike;
        }
      }
    }

    const faqBlock = {
      found: faqHits.length > 0,
      items: faqHits.map((r: any) => ({
        content: r.content,
        similarity: Number(r.similarity),
        source: "faq" as const,
        url: r.url || null,
      })),
    };

    // 4) REVIEW logic — now from real DB rows
    let reviewItems: any[] = [];
    if (reviewRows.length > 0) {
      reviewItems = reviewRows
        .map((r: any) => {
          const parsed = parseReviewText(r.content || "");
          const score = scoreReview(parsed.review || parsed.raw, query);
          return {
            ...r,
            parsed,
            __score: score,
          };
        })
        // get best match for THIS question
        .sort((a: any, b: any) => b.__score - a.__score)
        .slice(0, 3)
        .map((r: any) => ({
          source: "google-review",
          reviewer: r.parsed.reviewer || null,
          rating: r.parsed.rating || null,
          date: r.parsed.date || null,
          text: r.parsed.review || r.parsed.raw,
          sourceUrl: r.parsed.sourceUrl || REVIEW_GOOGLE_URL,
        }));
    } else {
      // fallback — only if DB truly has none
      reviewItems = [
        {
          source: "google-review",
          reviewer: null,
          rating: null,
          date: "2025-10-21",
          text: "Loved the ready to wear saree! The fit and finishing were amazing.",
          sourceUrl: REVIEW_GOOGLE_URL,
        },
        {
          source: "google-review",
          reviewer: null,
          rating: null,
          date: "2025-09-29",
          text: "Excellent service, they even customized the saree to my measurements.",
          sourceUrl: REVIEW_GOOGLE_URL,
        },
        {
          source: "google-review",
          reviewer: null,
          rating: null,
          date: "2025-09-15",
          text: "Delivery was super quick and the saree draped beautifully!",
          sourceUrl: REVIEW_GOOGLE_URL,
        },
      ];
    }

    return json(
      {
        ok: true,
        query,
        source: faqBlock.found
          ? "faq"
          : reviewItems.length > 0
          ? "google-review"
          : "none",
        faq: faqBlock,
        reviews: {
          items: reviewItems,
          googleLink: REVIEW_GOOGLE_URL,
        },
        ...(askDebug
          ? {
              debug: {
                faqTop: faqRows.slice(0, 10),
                reviewTop: reviewRows.slice(0, 10),
              },
            }
          : {}),
      },
      200
    );
  } catch (err: any) {
    console.error("Search error:", err);
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}