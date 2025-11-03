// app/api/search/route.ts
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

// —— Tunables ——
const FAQ_MIN_SIM = 0.55;           // similarity threshold for FAQ chunks
const MAX_FAQ_RETURN = 3;            // max FAQ chunks to show
const MAX_REVIEW_RETURN = 3;         // max reviews to show
const REVIEW_GOOGLE_URL =
  "https://www.google.com/search?q=wimo+ready+to+wear+saree+reviews";

// words that clearly mean “order/delivery FAQ” (fallback rescue)
const ORDER_KEYWORDS = [
  "order", "delivery", "when will i get", "where is my order",
  "track my order", "status", "pickup", "courier", "delayed"
];

// —— Helpers ——
function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function textMatchScore(text: string, query: string) {
  const qWords = normalize(query).split(" ").filter(Boolean);
  const t = normalize(text);
  let score = 0; for (const w of qWords) if (t.includes(w)) score += 1;
  return score;
}
function dbRowToSource(row: any): "faq" | "google-review" | "unknown" {
  // look across both doc meta and chunk meta
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

// Robust parser that extracts reviewer, rating, date, and the review text
function parseReviewText(raw: string) {
  const out: { reviewer: string | null; rating: number | null; date: string | null; review: string } =
    { reviewer: null, rating: null, date: null, review: "" };

  if (!raw) return out;
  const txt = raw.replace(/\r/g, "");

  // Reviewer name: handles displayName: 'Prajna', "displayName": "Prajna", Reviewer: 'Prajna'
  const mName =
    /displayName['"]?\s*[:=]\s*['"]([^'"]+)['"]/i.exec(txt) ||
    /reviewer\s*[:=]\s*['"]?([A-Za-z][^'"\n}]+)['"]?/i.exec(txt);
  if (mName) out.reviewer = mName[1].trim();

  // Rating: handles Rating: 4.8 | 4.5/5 | 5 stars
  const mRating =
    /rating\s*[:\-]?\s*([0-5](?:\.\d+)?)/i.exec(txt) ||
    /([0-5](?:\.\d+)?)\s*\/\s*5/.exec(txt) ||
    /([0-5](?:\.\d+)?)\s*stars?/i.exec(txt);
  out.rating = mRating ? Number(mRating[1]) : null;

  // Date: prefer ISO if available
  const mIso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(txt);
  const mDate = mIso || /date\s*[:\-]?\s*([^\n]+)\n?/i.exec(txt);
  out.date = mDate ? mDate[1].trim() : null;

  // Review body: prefer explicit "Review: ..." else take remainder; strip any leading JSON-ish blob
  const mBody = /(?:^|\n)\s*(?:review|comment)\s*[:\-]?\s*([\s\S]+)/i.exec(txt);
  out.review = (mBody ? mBody[1] : txt).replace(/^\s*\{[^]*?\}\s*/s, "").trim();

  return out;
}

// Small JSON helper with CORS
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    },
  });
}

// —— Route handlers (Next.js) ——
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
    const topK = Math.min(Math.max(Number(body?.topK ?? 12), 1), 30);

    if (!query) return json({ ok: false, error: "Missing 'query'" }, 400);

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return json({ ok: false, error: "Missing OPENAI_API_KEY or SUPABASE_CONN" }, 500);
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // 1) Embed the query
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const vec = `[${emb.data[0].embedding.join(",")}]`;

    // 2) Pull nearest chunks
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    const sql = `
      select
        dc.document_id,
        d.url,
        d.meta as doc_meta,
        dc.meta,
        dc.chunk_index,
        dc.content,
        1 - (dc.embedding <=> $1::vector) as similarity
      from document_chunks dc
      join documents d on d.id = dc.document_id
      where dc.embedding is not null
      order by dc.embedding <=> $1::vector
      limit $2;
    `;
    const { rows } = await client.query(sql, [vec, topK]);
    await client.end();

    // 3) Normalize & parse reviews
    const enriched = rows.map((r: any) => {
      const source = dbRowToSource(r);
      const base = {
        document_id: r.document_id,
        url: r.url,
        source,
        chunk_index: r.chunk_index,
        content: r.content,
        similarity: Number(r.similarity),
      };
      if (source === "google-review") {
        const pr = parseReviewText(r.content || "");
        return {
          ...base,
          review: {
            reviewer: pr.reviewer,
            rating: pr.rating,
            date: pr.date,
            text: pr.review || base.content,
          },
        };
      }
      return base;
    });

    // 4) FAQ first (similarity filter)
    let faqHits = enriched
      .filter((r: any) => r.source === "faq" && r.similarity >= FAQ_MIN_SIM)
      .slice(0, MAX_FAQ_RETURN);

    // Rescue: if user query looks like order/tracking and nothing passed threshold
    if (faqHits.length === 0) {
      const normQ = normalize(query);
      const looksOrder = ORDER_KEYWORDS.some((kw) => normQ.includes(kw));
      if (looksOrder) {
        const orderLike = enriched
          .filter((r: any) => r.source === "faq")
          .map((r: any) => {
            const score = ORDER_KEYWORDS.reduce(
              (acc, kw) => acc + (normalize(r.content).includes(kw) ? 1 : 0),
              0
            );
            return { ...r, orderScore: score };
          })
          .filter((r: any) => r.orderScore > 0)
          .sort((a: any, b: any) => b.orderScore - a.orderScore)
          .slice(0, 1);
        if (orderLike.length) faqHits = orderLike;
      }
    }

    // 5) Reviews: take google-review rows and rank by text match + slight recency bias (top list position)
    const parsedReviews = enriched.filter((r: any) => r.source === "google-review" && r.review?.text);

    const rankedReviews = parsedReviews
      .map((rv: any, idx: number) => ({
        reviewer: rv.review.reviewer || null,
        rating: rv.review.rating ?? null,
        date: rv.review.date || null,
        text: rv.review.text,
        _score: textMatchScore(rv.review.text, query) + Math.max(0, 5 - idx) * 0.2,
      }))
      .filter((rv: any) => rv._score > 0)
      .sort((a: any, b: any) => b._score - a._score)
      .slice(0, MAX_REVIEW_RETURN);

    // 6) Respond (FAQ primary + related reviews; always include reviewLink)
    return json(
      {
        ok: true,
        query,
        faq: faqHits.map((r: any) => ({ content: r.content, similarity: r.similarity })),
        reviews: rankedReviews.map(({ reviewer, rating, date, text }: any) => ({
          reviewer, rating, date, text,
        })),
        reviewLink: REVIEW_GOOGLE_URL,
      },
      200
    );
  } catch (err: any) {
    console.error("search route error:", err);
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}