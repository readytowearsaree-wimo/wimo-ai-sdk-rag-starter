// app/api/log/route.ts
import { NextResponse } from 'next/server';
import pkg from 'pg';

const { Client } = pkg;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders });
}

export async function POST(req: Request) {
  const client = new Client({
    connectionString: process.env.SUPABASE_CONN, // same as /api/ingest
    ssl: { rejectUnauthorized: false },
  });

  try {
    const body = await req.json();
    if (!body?.query_text) {
      return NextResponse.json(
        { error: 'query_text required' },
        { status: 400, headers: corsHeaders }
      );
    }

    await client.connect();

    await client.query(
      `insert into public.chat_queries
         (asked_at, session_id, url_path, user_agent, query_text,
          response_type, faq_id, faq_title, reviews_count, response_ms)
       values (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        body.session_id ?? null,
        body.url_path ?? null,
        body.user_agent ?? null,
        body.query_text,
        body.response_type ?? 'fallback',
        body.faq_id ?? null,
        body.faq_title ?? null,
        body.reviews_count ?? null,
        body.response_ms ?? null,
      ]
    );

    return NextResponse.json({ ok: true }, { headers: corsHeaders });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'unknown' },
      { status: 500, headers: corsHeaders }
    );
  } finally {
    try { await client.end(); } catch {}
  }
}
