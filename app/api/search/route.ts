// app/api/search/route.ts
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

// ---- Tunables ----------------------------------------------------
const FAQ_MIN_SIM = 0.55;
const MAX_FAQ_RETURN = 3;
const MAX_REVIEW_RETURN = 3;
const REVIEW_GOOGLE_URL =
  "https://www.google.com/search?q=wimo+ready+to+wear+saree+reviews";

const ORDER_KEYWORDS = [
  "order","delivery","when will i get","where is my order","track my order",
  "status","pickup","courier","delayed",
];

// ---- Small utils -------------------------------------------------
function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function textMatchScore(text: string, query: string) {
  const qWords = normalize(query).split(" ").filter(Boolean);
  const t = normalize(text || "");
  let score = 0;
  for (const w of qWords) if (t.includes(w)) score += 1;
  return score;
}

function parseReviewText(raw: string) {
  // Tolerant parser for your review lines
  const out: { reviewer?: string; rating?: number | null; date?: string | null; review?: string } = {};
  if (!raw) return out;
  const txt = raw.replace(/\r/g, "");

  const mName =
    /displayName['"]?\s*[:=]\s*['"]([^'"]+)['"]/i.exec(txt) ||
    /reviewer\s*:\s*['"]?([A-Za-z][^'"\n]+?)['"]?(?:\n|$)/i.exec(txt);
  if (mName) out.reviewer = mName[1].trim();

  const mRating =
    /rating\s*[:\-]?\s*(\d+(?:\.\d+)?)/i.exec(txt) ||
    /([0-5](?:\.\d+)?)\s*\/\s*5/.exec(txt);
  out.rating = mRating ? Number(mRating[1]) : null;

  const mIso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(txt);
  const mDateLine = mIso || /date\s*[:\-]?\s*([^\n]+)\n?/i.exec(txt);
  out.date = mDateLine ? mDateLine[1].trim() : null;

  const mReview =
    /^(?:review|comment)\s*:\s*([\s\S]+)$/im.exec(txt) ||
    /(?:^|[\n])\s*[-–•]\s*([\s\S]+)$/m.exec(txt);
  out.review = (mReview ? mReview[1] : txt).trim();

  return out;
}

function rowSource(row: any): "faq" | "google-review" | "unknown" {
  const m = row.meta || {};
  const d = row.doc_meta || {};
  const src =
    m.source || m.type || m.sourceBucket ||
    d.source || d.type || d.sourceBucket ||
    row.sourceBucket || "faq";
  if (src === "faq") return "faq";
  if (src === "google-review") return "google-review";
  return "unknown";
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

// ---- CORS preflight & health ------------------------------------
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

// ---- MAIN --------------------------------------------------------
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? "").toString().trim();
    const topK = Math.min(Math.max(Number(body?.topK ?? 12), 1), 30);
    const askDebug = !!body?.debug;

    if (!query) return json({ ok: false, error: "Missing 'query'" }, 400);

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return json({ ok: false, error: "Missing OPENAI_API_KEY or SUPABASE_CONN" }, 500);
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // 1) embed query
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(",")}]`;

    // 2) fetch nearest chunks
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

    // 3) normalize rows and split by source
    const enriched = rows.map((r: any) => {
      const source = rowSource(r);
      const base = {
        document_id: r.document_id,
        url: r.url,
        source,
        chunk_index: r.chunk_index,
        content: r.content as string,
        similarity: Number(r.similarity),
        meta: r.meta ?? null,
      };
      if (source === "google-review") {
        const parsed = parseReviewText(base.content || "");
        return {
          ...base,
          review: {
            reviewer: parsed.reviewer || null,
            rating: parsed.rating ?? null,
            date: parsed.date || null,
            text: parsed.review || base.content,
          },
        };
      }
      return base;
    });

    // 4) FAQ first (+ order rescue)
    let faqHits = enriched
      .filter((r: any) => r.source === "faq" && r.similarity >= FAQ_MIN_SIM)
      .slice(0, MAX_FAQ_RETURN);

    if (faqHits.length === 0) {
      const normQ = normalize(query);
      const looksLikeOrder = ORDER_KEYWORDS.some((kw) => normQ.includes(kw));
      if (looksLikeOrder) {
        const orderLike = enriched
          .filter((r: any) => r.source === "faq")
          .map((r: any) => ({
            ...r,
            orderScore: ORDER_KEYWORDS.reduce(
              (acc, kw) => acc + (normalize(r.content).includes(kw) ? 1 : 0),
              0
            ),
          }))
          .filter((r: any) => r.orderScore > 0)
          .sort((a: any, b: any) => b.orderScore - a.orderScore)
          .slice(0, 1);
        if (orderLike.length > 0) faqHits = orderLike;
      }
    }

    // 5) Reviews: score by simple word match + slight recency bias
    const rawReviews = enriched.filter((r: any) => r.source === "google-review");
    const relatedReviews = rawReviews
      .map((r: any, i: number) => {
        const text = r.review?.text || r.content || "";
        return {
          reviewer: r.review?.reviewer || null,
          rating: r.review?.rating ?? null,
          date: r.review?.date || null,
          text,
          __score: textMatchScore(text, query) + Math.max(0, 5 - i) * 0.2,
        };
      })
      .filter((rv: any) => rv.__score > 0)
      .sort((a: any, b: any) => b.__score - a.__score)
      .slice(0, MAX_REVIEW_RETURN)
      .map(({ __score, ...keep }) => keep);

    // 6) Build final payload: FAQ (if any) + Reviews block (even if empty)
    const responseObj: any = {
      ok: true,
      query,
      sources: {
        faq: "faq",
        reviews: "google-review",
      },
      faq: faqHits.map((r: any) => ({
        content: r.content,
        similarity: r.similarity,
      })),
      reviews: relatedReviews,
      reviewLink: REVIEW_GOOGLE_URL,
      ...(askDebug ? { debug: { top: enriched.slice(0, 8) } } : {}),
    };

    // If absolutely nothing matched, keep a friendly message
    if (responseObj.faq.length === 0 && responseObj.reviews.length === 0) {
      responseObj.message = "I couldn’t find this in FAQs or reviews.";
    }

    return json(responseObj, 200);
  } catch (err: any) {
    console.error("Search error:", err);
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}