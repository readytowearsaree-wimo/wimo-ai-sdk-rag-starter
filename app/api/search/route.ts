import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Pool } from "pg";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const pool = new Pool({ connectionString: process.env.SUPABASE_CONN! });

function ok(body: any, init: number = 200) {
  return NextResponse.json(body, { status: init });
}

export async function POST(req: NextRequest) {
  let client;
  try {
    const { query } = await req.json();
    const userQuery = String(query || "").trim();
    if (!userQuery) return ok({ faq: { found: false, items: [] } });

    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: userQuery,
    });
    const vec = emb.data[0].embedding;
    if (!vec || vec.length !== 1536) throw new Error("Bad embedding");
    const vecLiteral = `[${vec.join(",")}]`;

    const sql = `
      WITH q AS (SELECT $1::vector(1536) AS v)
      SELECT
        d.id,
        d.url,
        d.title,
        dc.content,
        1 - (dc.embedding <=> q.v) AS emb_sim,
        CASE
          WHEN to_tsvector('simple', dc.content) @@ plainto_tsquery('simple', $2) THEN 1
          ELSE 0
        END AS fts_hit
      FROM public.document_chunks dc
      JOIN public.documents d ON d.id = dc.document_id
      JOIN q ON TRUE
      WHERE d.url LIKE 'faq://%%'
      ORDER BY fts_hit DESC, (dc.embedding <-> q.v) ASC
      LIMIT 10;
    `;

    client = await pool.connect();
    const { rows } = await client.query(sql, [vecLiteral, userQuery]);
    const MIN_SIM = 0.45;

    const items = (rows || [])
      .map((r) => ({
        id: r.id as string,
        url: (r.url as string) ?? null,
        title: (r.title as string) ?? null,
        content: r.content as string,
        similarity: Number(r.emb_sim),
      }))
      .filter((it) => it.similarity >= MIN_SIM)
      .slice(0, 5);

    return ok({ faq: { found: items.length > 0, items } });
  } catch (err) {
    console.error("[/api/answer] error", err);
    return ok({ faq: { found: false, items: [] } });
  } finally {
    if (client) client.release();
  }
}
