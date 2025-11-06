// /app/api/search/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Pool } from "pg";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Use your Supabase Postgres connection string (service role or anon with RLS allowed)
const pool = new Pool({
  connectionString: process.env.SUPABASE_CONN, // e.g. postgresql://user:pass@host:5432/postgres
  // ssl: { rejectUnauthorized: false }, // uncomment if your DB requires SSL
});

export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();
    const userQuery = String(query || "").trim();

    if (!userQuery) {
      return NextResponse.json(
        { faq: { found: false, items: [] }, reviews: { items: [] } },
        { status: 200 }
      );
    }

    // 1) Embed the query
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: userQuery,
    });
    const vec = emb.data[0].embedding;
    if (!vec || vec.length !== 1536) throw new Error("Bad embedding shape");

    const vecLiteral = `[${vec.join(",")}]`;

    // 2) Vector search on CHUNKS (not documents), limit 5
    //    IMPORTANT: lower the cutoff so short queries like "plus size" pass.
    const sql = `
      WITH q AS (SELECT $1::vector(1536) AS v)
      SELECT 
        d.id,
        d.url,
        d.title,
        dc.content,
        1 - (dc.embedding <=> q.v) AS similarity
      FROM public.document_chunks dc
      JOIN public.documents d ON d.id = dc.document_id
      JOIN q ON TRUE
      WHERE d.url LIKE 'faq://%'
      ORDER BY dc.embedding <-> q.v
      LIMIT 5;
    `;

    const client = await pool.connect();
    const { rows } = await client.query(sql, [vecLiteral]);
    client.release();

    // 3) Pick the best item and apply a friendly threshold (0.55–0.60)
    const best = rows?.[0];
    const MIN_SIM = 0.55; // <- tune later; your test printed ~0.697 for "plus size"
    const found = !!best && Number(best.similarity) >= MIN_SIM;

    const items = (rows || []).map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title ?? null,
      content: r.content, // your frontend strips "A:" etc. itself
      similarity: Number(r.similarity),
    }));

    // 4) Return exactly what the frontend expects
    return NextResponse.json(
      {
        faq: { found, items },
        reviews: { items: [], googleLink: null }, // optional; your UI handles empty
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("/api/search error", err);
    return NextResponse.json(
      { faq: { found: false, items: [] }, reviews: { items: [] } },
      { status: 200 }
    );
  }
}
