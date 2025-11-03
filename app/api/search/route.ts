// app/api/search/route.ts
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

// loosened a bit because some of your FAQs are long
const FAQ_MIN_SIM = 0.55;
const MAX_FAQ_RETURN = 3;
const REVIEW_GOOGLE_URL =
  "https://www.google.com/search?q=wimo+ready+to+wear+saree+reviews";

// words that clearly indicate the “order / delivery / track” FAQ
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

// for reviews: quick lexical score
function textMatchScore(text: string, query: string) {
  const qWords = normalize(query)
    .split(" ")
    .filter(Boolean);
  const t = normalize(text);
  let score = 0;
  for (const w of qWords) {
    if (t.includes(w)) score += 1;
  }
  return score;
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

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.toLowerCase().startsWith("reviewer:")) {
      out.reviewer = line.split(":").slice(1).join(":").trim();
    } else if (line.toLowerCase().startsWith("rating:")) {
      const num = Number(line.replace(/rating:/i, "").trim());
      if (!Number.isNaN(num)) out.rating = num;
    } else if (line.toLowerCase().startsWith("date:")) {
      out.date = line.replace(/date:/i, "").trim();
    } else if (line.toLowerCase().startsWith("source:")) {
      out.sourceUrl = line.replace(/source:/i, "").trim();
    }
  }

  const reviewLine = lines.find(
    (l) =>
      l.toLowerCase().startsWith("review:") ||
      l.toLowerCase().startsWith("comment:")
  );
  if (reviewLine) {
    out.review = reviewLine.split(":").slice(1).join(":").trim();
  } else {
    out.review = raw.trim();
  }

  return out;
}

function dbRowToSource(row: any): "faq" | "google-review" | "unknown" {
  const m = row.meta || {};
  const d = row.doc_meta || {};
  const source =
    m.source ||
    m.type ||
    m.sourceBucket ||
    d.source ||
    d.type ||
    d.sourceBucket ||
    row.sourceBucket ||
    "faq"; // default to faq so FAQs without meta still work
  if (source === "google-review") return "google-review";
  if (source === "faq") return "faq";
  return "unknown";
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
  return new Response(JSON.stringify({ ok: true, msg: "search route is alive" }), {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    },
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? "").toString().trim();
    const topK = Math.min(Math.max(Number(body?.topK ?? 14), 1), 40);
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

    // 1) embed
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(",")}]`;

    // 2) PG
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

    // 3) normalize rows
    const enriched = rows.map((r: any) => {
      const source = dbRowToSource(r);
      const base: any = {
        document_id: r.document_id,
        url: r.url,
        source,
        chunk_index: r.chunk_index,
        content: r.content,
        similarity: Number(r.similarity),
      };
      if (source === "google-review") {
        const parsed = parseReviewText(r.content || "");
        base.review = {
          reviewer: parsed.reviewer || null,
          rating: parsed.rating || null,
          date: parsed.date || null,
          text: parsed.review || parsed.raw,
          sourceUrl: parsed.sourceUrl || null,
        };
      }
      return base;
    });

    // 4) pick FAQ — guarantee at least one if any FAQ exists
    const allFaqs = enriched.filter((r) => r.source === "faq");
    // first try by similarity
    let faqHits = allFaqs.filter((r) => r.similarity >= FAQ_MIN_SIM);
    faqHits = faqHits.slice(0, MAX_FAQ_RETURN);

    // rescue: if none passed threshold but we DO have FAQ rows, take the first one
    if (faqHits.length === 0 && allFaqs.length > 0) {
      // special rescue for order/delivery
      const normQ = normalize(query);
      const looksLikeOrder = ORDER_KEYWORDS.some((kw) =>
        normQ.includes(kw)
      );
      if (looksLikeOrder) {
        const orderLike = allFaqs
          .map((r) => {
            const score = ORDER_KEYWORDS.reduce((acc, kw) => {
              return acc + (normalize(r.content).includes(kw) ? 1 : 0);
            }, 0);
            return { ...r, orderScore: score };
          })
          .filter((r) => r.orderScore > 0)
          .sort((a, b) => b.orderScore - a.orderScore);
        if (orderLike.length > 0) {
          faqHits = orderLike.slice(0, 1);
        } else {
          faqHits = allFaqs.slice(0, 1);
        }
      } else {
        // just take the most similar faq even if sim is low
        faqHits = allFaqs.slice(0, 1);
      }
    }

    // 5) pick related reviews — lexical + recency-ish
    const reviewRows = enriched.filter((r) => r.source === "google-review");
    const scoredReviews = reviewRows
      .map((r: any, idx: number) => {
        const textForScore = r.review?.text || r.content || "";
        const s = textMatchScore(textForScore, query);
        // slight bonus for earlier rows (closer to embedding match)
        const orderBonus = Math.max(0, 5 - idx); // 5,4,3,2,1,...
        return { ...r, __score: s + orderBonus * 0.2 };
      })
      .filter((r) => r.__score > 0) // only ones that actually matched
      .sort((a, b) => b.__score - a.__score)
      .slice(0, 3)
      .map((r) => ({
        reviewer: r.review?.reviewer || null,
        rating: r.review?.rating || null,
        date: r.review?.date || null,
        text: r.review?.text || r.content,
      }));

    // 6) now build response
    if (faqHits.length > 0) {
      return json(
        {
          ok: true,
          query,
          source: "faq",
          results: faqHits.map((r) => ({
            content: r.content,
            similarity: r.similarity,
          })),
          relatedReviews: scoredReviews, // can be empty
          reviewLink: REVIEW_GOOGLE_URL,
          ...(askDebug ? { debug: { top: enriched.slice(0, 10) } } : {}),
        },
        200
      );
    }

    // if no FAQ at all, but we do have reviews
    if (scoredReviews.length > 0) {
      return json(
        {
          ok: true,
          query,
          source: "google-review",
          results: scoredReviews,
          reviewLink: REVIEW_GOOGLE_URL,
          ...(askDebug ? { debug: { top: enriched.slice(0, 10) } } : {}),
        },
        200
      );
    }

    // truly nothing
    return json(
      {
        ok: true,
        query,
        source: "none",
        results: [],
        reviewLink: REVIEW_GOOGLE_URL,
        message: "I couldn’t find this in FAQs or reviews.",
        ...(askDebug ? { debug: { top: enriched.slice(0, 10) } } : {}),
      },
      200
    );
  } catch (err: any) {
    console.error("Search error:", err);
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}

// helper to always send CORS
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    },
  });
}