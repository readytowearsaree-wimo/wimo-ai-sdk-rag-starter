import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { Pool } from "pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


/* ---------- CORS ---------- */
function cors(res: NextResponse) {
  res.headers.set("Access-Control-Allow-Origin", "*"); // tighten if you want
  res.headers.set("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

/* ---------- Clients ---------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const pool = new Pool({
  connectionString: process.env.SUPABASE_CONN!, // e.g. postgresql://user:pass@host:5432/postgres
  ssl: { rejectUnauthorized: false },           // Supabase needs SSL in most envs
});

/* ---------- Helpers ---------- */
function ok(body: any, status = 200) {
  return cors(NextResponse.json(body, { status }));
}
function fail(debug: boolean, where: string, err: unknown) {
  console.error(`[search] ${where}`, err);
  return ok({
    faq: { found: false, items: [] },
    reviews: { items: [], googleLink: null },
    ...(debug ? { _error: String(err), _where: where } : {}),
  });
}

async function readBody(req: NextRequest) {
  // Accept JSON or form; tolerate different keys: query / q / text
  let q = "";
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      const j = await req.json();
      q = (j?.query || j?.q || j?.text || "").toString();
    } catch {
      q = "";
    }
  } else if (ct.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    q = ((form.get("query") || form.get("q") || form.get("text")) ?? "").toString();
  } else {
    // best effort
    try {
      const j = await req.json();
      q = (j?.query || j?.q || j?.text || "").toString();
    } catch { /* ignore */ }
  }
  return q.trim();
}

/* ---------- The route ---------- */
export async function POST(req: NextRequest) {
  const debug = req.nextUrl.searchParams.get("debug") === "1";
  let client;
  try {
    const userQuery = await readBody(req);
    if (!userQuery) {
      return ok({ faq: { found: false, items: [] }, reviews: { items: [], googleLink: null } });
    }

    // 1) Embed
    let vec: number[];
    try {
      const emb = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: userQuery,
      });
      vec = emb.data[0].embedding;
      if (!vec || vec.length !== 1536) throw new Error(`embedding length ${vec?.length}`);
    } catch (e) {
      return fail(debug, "openai.embeddings", e);
    }
    const vecLiteral = `[${vec.join(",")}]`;

    // 2) Query DB (hybrid ranking: FTS bump + embeddings on CHUNKS)
    const sql = `
      WITH q AS (SELECT $1::vector(1536) AS v)
      SELECT
        d.id,
        d.url,
        d.title,
        d.meta,
        dc.content,
        1 - (dc.embedding <=> q.v) AS emb_sim,
        CASE
          WHEN to_tsvector('simple', dc.content) @@ plainto_tsquery('simple', $2) THEN 1
          ELSE 0
        END AS fts_hit
      FROM public.document_chunks dc
      JOIN public.documents d ON d.id = dc.document_id
      JOIN q ON TRUE
      WHERE dc.embedding IS NOT NULL
        AND d.url LIKE 'faq://%%'
      ORDER BY fts_hit DESC, (dc.embedding <-> q.v) ASC
      LIMIT 10;
    `;

    try {
      client = await pool.connect();
    } catch (e) {
      return fail(debug, "pg.connect", e);
    }

    let rows: any[] = [];
    try {
      const r = await client.query(sql, [vecLiteral, userQuery]);
      rows = r.rows || [];
    } catch (e) {
      client.release();
      return fail(debug, "pg.query", e);
    }
    client.release();

    // 3) Select top answers; keep a LOW floor for short queries
    const MIN_SIM = 0.45;
    const items = rows
      .map((r) => ({
        id: r.id as string,
        url: (r.url as string) ?? null,
        title: (r.title as string) ?? null,
        content: r.content as string,
        similarity: Number(r.emb_sim),
        _fts: Number(r.fts_hit),
      }))
      .filter((it) => it.similarity >= MIN_SIM || it._fts === 1)
      .slice(0, 5);

    const found = items.length > 0;

    return ok({
      faq: { found, items },
      reviews: { items: [], googleLink: null },
      ...(debug ? { _debug: { q: userQuery, count: rows.length, kept: items.length } } : {}),
    });
  } catch (e) {
    return fail(debug, "outer", e);
  }
}
