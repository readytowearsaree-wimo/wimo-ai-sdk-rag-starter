// app/api/log/route.ts
import { NextResponse } from "next/server";
import pkg from "pg";
const { Client } = pkg;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders });
}

export async function POST(req: Request) {
  const client = new Client({
    connectionString: process.env.SUPABASE_CONN,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const body = await req.json();
    const {
      session_id,
      url_path,
      user_agent,
      query_text,
      response_type,
      faq_id,
      faq_title,
      reviews_count,
      response_ms,
      response_text,         // 👈 new field
    } = body;

    if (!query_text) {
      return NextResponse.json(
        { error: "query_text required" },
        { status: 400, headers: corsHeaders }
      );
    }

    await client.connect();
    await client.query(
      `insert into public.chat_queries
         (asked_at, session_id, url_path, user_agent, query_text,
          response_type, faq_id, faq_title, reviews_count, response_ms, response_text)
       values (now(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        session_id ?? null,
        url_path ?? null,
        user_agent ?? null,
        query_text,
        response_type ?? "fallback",
        faq_id ?? null,
        faq_title ?? null,
        reviews_count ?? null,
        response_ms ?? null,
        response_text ?? null,  // 👈 store it
      ]
    );

    return NextResponse.json({ ok: true }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("log error:", err);
    return NextResponse.json(
      { error: err?.message || "unknown" },
      { status: 500, headers: corsHeaders }
    );
  } finally {
    try { await client.end(); } catch {}
  }
}
