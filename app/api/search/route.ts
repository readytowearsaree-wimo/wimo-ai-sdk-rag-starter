// app/api/search/route.ts
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

// ---- Tuning ----
const FAQ_MIN_SIM = 0.55;        // similarity gate for FAQ
const MAX_FAQ_RETURN = 3;
const MAX_REVIEW_RETURN = 3;
const REVIEW_GOOGLE_URL =
  "https://www.google.com/search?q=wimo+ready+to+wear+saree+reviews";

// ---- Helpers ----
function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function textMatchScore(text: string, query: string) {
  const qWords = normalize(query).split(" ").filter(Boolean);
  const t = normalize(text);
  let score = 0;
  for (const w of qWords) if (t.includes(w)) score += 1;
  return score;
}

// Try to pull reviewer / rating / date out of your “Google review” rows
function parseReviewText(raw: string) {
  const out: { reviewer?: string|null; rating?: number|null; date?: string|null; text: string } = {
    reviewer: null, rating: null, date: null, text: (raw || "").trim()
  };
  if (!raw) return out;

  const txt = raw.replace(/\r/g, "");

  // reviewer → supports lines like:
  //   Reviewer: {'displayName': 'Prajna Kirtane'}
  //   displayName: 'Sabitha AM'
  const mName =
    /displayName['"]?\s*[:=]\s*['"]([^'"]+)['"]/i.exec(txt) ||
    /reviewer\s*:\s*['"]?([A-Za-z][^'"\n]+?)['"]?(?:\n|$)/i.exec(txt);
  if (mName) out.reviewer = mName[1].trim();

  // rating → “Rating: 4.8”, or “4.5/5”
  const mRating =
    /rating\s*[:\-]?\s*(\d+(?:\.\d+)?)/i.exec(txt) ||
    /([0-5](?:\.\d+)?)\s*\/\s*5/i.exec(txt);
  out.rating = mRating ? Number(mRating[1]) : null;

  // date → prefer ISO like 2025-10-21, else `Date: ...`
  const mIso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(txt) ||
               /date\s*[:\-]?\s*([^\n]+)\n?/i.exec(txt);
  out.date = mIso ? mIso[1].trim() : null;

  // review body → “Review: …” or keep raw
  const mReview = /(?:^|\n)\s*(?:review|comment)\s*:\s*([\s\S]+)$/i.exec(txt);
  if (mReview) out.text = mReview[1].trim();

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

// ---- CORS / health ----
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
  return json({ ok: true, msg: "search route is alive" });
}

// ---- Main ----
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

    // 1) Query embedding
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vec = `[${queryEmbedding.join(",")}]`;

    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // 2) FAQ via vector search (only FAQ rows)
    const faqSql = `
      SELECT dc.document_id, d.url, d.meta AS doc_meta, dc.chunk_index, dc.content,
             1 - (dc.embedding <=> $1::vector) AS similarity
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
      WHERE (d.meta->>'source') = 'faq' AND dc.embedding IS NOT NULL
      ORDER BY dc.embedding <=> $1::vector
      LIMIT $2;
    `;
    const faqRes = await client.query(faqSql, [vec, topK]);

    // 3) Google-reviews:
    // 3a) Prefer vector search if embeddings exist for reviews
    const revVecSql = `
      SELECT dc.document_id, d.url, d.meta AS doc_meta, dc.chunk_index, dc.content,
             1 - (dc.embedding <=> $1::vector) AS similarity
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
      WHERE (d.meta->>'source') = 'google-review' AND dc.embedding IS NOT NULL
      ORDER BY dc.embedding <=> $1::vector
      LIMIT $2;
    `;
    const revVecRes = await client.query(revVecSql, [vec, topK]);

    // 3b) Fallback keyword search if no review embeddings yet
    let revKeyRes = { rows: [] as any[] };
    if (revVecRes.rows.length === 0) {
      // build loose ILIKE clause from first few meaningful words
      const words = normalize(query).split(" ").filter(w => w.length > 2).slice(0, 5);
      const likeConds = words.map((_, i) => `dc.content ILIKE $${i + 3}`).join(" OR ") || "TRUE";
      const params = [vec, topK, ...words.map(w => `%${w}%`)];
      const revKeySql = `
        SELECT dc.document_id, d.url, d.meta AS doc_meta, dc.chunk_index, dc.content,
               0.0 AS similarity
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        WHERE (d.meta->>'source') = 'google-review'
          AND (${likeConds})
        LIMIT $2;
      `;
      revKeyRes = await client.query(revKeySql, params);
    }

    await client.end();

    // Format FAQ
    const faqHits = faqRes.rows
      .filter(r => Number(r.similarity) >= FAQ_MIN_SIM)
      .slice(0, MAX_FAQ_RETURN)
      .map(r => ({
        content: r.content,
        similarity: Number(r.similarity),
        source: "faq",
      }));

    // Parse & score reviews (from whichever branch returned rows)
    const reviewRows = (revVecRes.rows.length ? revVecRes.rows : revKeyRes.rows) as any[];

    const parsedReviews = reviewRows.map(r => {
      const parsed = parseReviewText(r.content || "");
      const createdAt = (r.created_at ? Date.parse(r.created_at) : 0) || 0;
      return {
        reviewer: parsed.reviewer ?? null,
        rating: parsed.rating ?? null,
        date: parsed.date ?? null,
        text: parsed.text,
        _recency: createdAt,
      };
    });

    const reviews = parsedReviews
      .map((rv, i) => ({
        ...rv,
        _score: textMatchScore(rv.text, query) + Math.max(0, 5 - i) * 0.2,
      }))
      .filter(rv => rv._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, MAX_REVIEW_RETURN)
      .map(({ reviewer, rating, date, text }) => ({ reviewer, rating, date, text }));

    // Response contains BOTH sections so the UI can render FAQ first, then reviews
    return json({
      ok: true,
      query,
      sources: { faq: "faq", reviews: "google-review" },
      faq: faqHits,                    // array
      reviews,                         // array
      reviewLink: REVIEW_GOOGLE_URL,   // always include link
    });
  } catch (err: any) {
    console.error("Search error:", err);
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}