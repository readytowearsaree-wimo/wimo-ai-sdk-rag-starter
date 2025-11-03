import { NextResponse } from "next/server";
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

// ↓↓↓ made it looser
const FAQ_MIN_SIM = 0.63;   // was 0.78
const MAX_RETURN = 3;
const REVIEW_GOOGLE_URL =
  "https://www.google.com/search?q=wimo+ready+to+wear+saree+reviews";

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
  // default
  const out: {
    reviewer?: string;
    rating?: number;
    date?: string;
    review?: string;
    sourceUrl?: string;
    raw: string;
  } = { raw };

  if (!raw) return out;

  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (line.toLowerCase().startsWith('reviewer:')) {
      out.reviewer = line.split(':').slice(1).join(':').trim();
    } else if (line.toLowerCase().startsWith('rating:')) {
      const num = Number(line.replace(/rating:/i, '').trim());
      if (!Number.isNaN(num)) out.rating = num;
    } else if (line.toLowerCase().startsWith('date:')) {
      out.date = line.replace(/date:/i, '').trim();
    } else if (line.toLowerCase().startsWith('source:')) {
      out.sourceUrl = line.replace(/source:/i, '').trim();
    }
  }

  // find the first line that looks like the actual review
  const reviewLine = lines.find(l =>
    l.toLowerCase().startsWith('review:') ||
    l.toLowerCase().startsWith('comment:')
  );
  if (reviewLine) {
    out.review = reviewLine.split(':').slice(1).join(':').trim();
  } else {
    // fallback: use the whole thing
    out.review = raw.trim();
  }

  return out;
}

function dbRowToSource(row: any): 'faq' | 'google-review' | 'unknown' {
  // we fixed this earlier, but keep it safe
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
    'faq';
  return source === 'google-review' ? 'google-review' : source === 'faq' ? 'faq' : 'unknown';
}


// placeholder; you can remove once reviews table is used
const REVIEWS = [
  { text: "Loved the ready to wear saree! The fit and finishing were amazing.", date: "2025-10-21" },
  { text: "Excellent service, they even customized the saree to my measurements.", date: "2025-09-29" },
  { text: "Delivery was super quick and the saree draped beautifully!", date: "2025-09-15" },
  { text: "Very comfortable fabric. I’ll definitely buy again!", date: "2025-09-10" },
];

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
    const wantReviewsOnly = !!body?.showReviews;
    const askDebug = !!body?.debug;             // 👈 to see what PG returned
    const topK = Math.min(Math.max(Number(body?.topK ?? 12), 1), 30);

    if (!query) {
      return json({ ok: false, error: "Missing 'query'" }, 400);
    }

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

    // 2) fetch chunks from Postgres
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

    // 3) normalize source
   const enriched = rows.map((r: any) => {
  const source = dbRowToSource(r);

  // base object
  const base = {
    document_id: r.document_id,
    url: r.url,
    source,
    chunk_index: r.chunk_index,
    content: r.content,
    similarity: Number(r.similarity),
  };

  // if it's a google review, try to extract fields
  if (source === 'google-review') {
    const parsed = parseReviewText(r.content || '');
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


    // 4) user clicked "yes, check reviews" -> you already added this in Wix
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

      const topReviews = scored.slice(0, 3);
      return json(
        {
          ok: true,
          query,
          source: "google-review",
          results: topReviews.map((r) => ({ content: r.text, date: r.date })),
          reviewLink: REVIEW_GOOGLE_URL,
        },
        200
      );
    }

    // 5) FAQ-FIRST branch (this is the one that didn’t trigger for you)
    const faqHits = enriched
      .filter((r: any) => r.source === "faq" && r.similarity >= FAQ_MIN_SIM)
      .slice(0, 3);

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
          canShowReviews: true,
          // 👇 for debugging in Wix: see what else matched
          ...(askDebug ? { debug: { top: enriched.slice(0, 8) } } : {}),
        },
        200
      );
    }

   // 6) fallback to reviews — use actual google-review rows from DB
const dbReviews = enriched.filter((r: any) => r.source === 'google-review');

// simple relevance (you can later add cosine sim scoring if needed)
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
      source: 'google-review',
      results: topReviews,
      reviewLink: REVIEW_GOOGLE_URL,
      ...(askDebug ? { debug: { top: enriched.slice(0, 8) } } : {}),
    },
    200
  );
}


    // 7) truly nothing
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
