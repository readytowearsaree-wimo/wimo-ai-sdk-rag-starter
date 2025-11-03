// app/api/search/route.ts
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

/* -------------------- CONFIG -------------------- */
const FAQ_MIN_SIM = 0.63; // looser so your FAQ wins more often
const MAX_RETURN = 3;
const REVIEW_GOOGLE_URL =
  "https://www.google.com/search?q=wimo+ready+to+wear+saree+reviews";

/* -------------------- HELPERS -------------------- */
function normalize(str: string) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseReviewText(raw: string) {
  // structure we want to end up with
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

  // actual review line
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

// figure out if a row is faq or google-review
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
    "faq"; // default to faq
  if (source === "google-review") return "google-review";
  if (source === "faq") return "faq";
  return "unknown";
}

/* -------------------- CORS HELPERS -------------------- */
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    },
  });
}

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

/* -------------------- MAIN POST -------------------- */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? "").toString().trim();
    const wantReviewsOnly = !!body?.showReviews; // second call from Wix
    const askDebug = !!body?.debug;
    const topK = Math.min(Math.max(Number(body?.topK ?? 12), 1), 30);

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

    /* 1) embed query */
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(",")}]`;

    /* 2) fetch nearest chunks from Postgres */
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

    /* 3) normalize rows, parse reviews */
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
        const parsed = parseReviewText(r.content || "");
        return {
          ...base,
          review: {
            reviewer: parsed.reviewer || null,
            rating: parsed.rating || null,
            date: parsed.date || null,
            text: parsed.review || parsed.raw,
            sourceUrl: parsed.sourceUrl || null,
          },
        };
      }

      return base;
    });

    /* 4) user explicitly asked for reviews (second call from frontend) */
    if (wantReviewsOnly) {
      const dbReviews = enriched.filter(
        (r: any) => r.source === "google-review"
      );

      const topReviews = dbReviews.slice(0, 3).map((r: any) => ({
        content: r.review?.text || r.content,
        reviewer: r.review?.reviewer || null,
        rating: r.review?.rating || null,
        date: r.review?.date || null,
        sourceUrl: r.review?.sourceUrl || null,
      }));

      if (topReviews.length > 0) {
        return json(
          {
            ok: true,
            query,
            source: "google-review",
            message: "Here are customer reviews related to this:",
            results: topReviews,
            reviewLink: REVIEW_GOOGLE_URL,
          },
          200
        );
      }

      return json(
        {
          ok: true,
          query,
          source: "google-review",
          results: [],
          message:
            "I couldn’t match any customer reviews. You can see all on Google.",
          reviewLink: REVIEW_GOOGLE_URL,
        },
        200
      );
    }

    /* 5) FAQ-FIRST branch */
    const faqHits = enriched
      .filter((r: any) => r.source === "faq" && r.similarity >= FAQ_MIN_SIM)
      .slice(0, MAX_RETURN);

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
          canShowReviews: true, // 👈 front end shows "Check if any customer reviews talk about this"
          ...(askDebug ? { debug: { top: enriched.slice(0, 8) } } : {}),
        },
        200
      );
    }

    /* 6) fallback to reviews (first call, but no FAQ found) */
    const dbReviews = enriched.filter(
      (r: any) => r.source === "google-review"
    );

    const topReviews = dbReviews.slice(0, 3).map((r: any) => ({
      content: r.review?.text || r.content,
      reviewer: r.review?.reviewer || null,
      rating: r.review?.rating || null,
      date: r.review?.date || null,
      sourceUrl: r.review?.sourceUrl || null,
    }));

    if (topReviews.length > 0) {
      return json(
        {
          ok: true,
          query,
          source: "google-review",
          message: "I didn’t find this in FAQs, but customers said this:",
          results: topReviews,
          reviewLink: REVIEW_GOOGLE_URL,
          ...(askDebug ? { debug: { top: enriched.slice(0, 8) } } : {}),
        },
        200
      );
    }

    /* 7) truly nothing */
    return json(
      {
        ok: true,
        query,
        source: "none",
        results: [],
        message: "I couldn’t find this in FAQs or reviews.",
        ...(askDebug ? { debug: { top: enriched.slice(0, 8) } } : {}),
      },
      200
    );
  } catch (err: any) {
    console.error("Search error:", err);
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}