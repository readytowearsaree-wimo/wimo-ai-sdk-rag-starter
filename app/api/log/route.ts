// app/api/log/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabase = createClient(process.env.SUPABASE_CONN!);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body?.query_text) {
      return NextResponse.json({ error: 'query_text required' }, { status: 400 });
    }

    const { error } = await supabase.from('chat_queries').insert({
      asked_at: new Date().toISOString(),
      session_id: body.session_id ?? null,
      url_path: body.url_path ?? null,
      user_agent: body.user_agent ?? null,
      query_text: body.query_text,
      response_type: body.response_type ?? 'fallback',
      faq_id: body.faq_id ?? null,
      faq_title: body.faq_title ?? null,
      reviews_count: body.reviews_count ?? null,
      response_ms: body.response_ms ?? null,
    });

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'unknown' }, { status: 500 });
  }
}
