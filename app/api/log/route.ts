import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // server-side only
  { auth: { persistSession: false } }
);

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // minimal validation
    if (!body?.query_text) {
      return NextResponse.json({ error: 'query_text required' }, { status: 400 });
    }

    const { data, error } = await supabase.from('chat_queries').insert({
      asked_at: new Date().toISOString(),
      session_id: body.session_id || null,
      url_path: body.url_path || null,
      user_agent: body.user_agent || null,
      query_text: body.query_text,
      response_type: body.response_type || 'fallback',
      faq_id: body.faq_id || null,
      faq_title: body.faq_title || null,
      reviews_count: body.reviews_count ?? null,
      response_ms: body.response_ms ?? null,
    }).select('id').single();

    if (error) throw error;
    return NextResponse.json({ ok: true, id: data.id });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'unknown' }, { status: 500 });
  }
}