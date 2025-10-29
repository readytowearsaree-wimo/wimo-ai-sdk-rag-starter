// app/api/ingest/route.ts
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const url = body.url || body.sitemap;
    if (!url) {
      return NextResponse.json({ ok: false, error: 'No url or sitemap provided' }, { status: 400 });
    }

    // Dummy test response for now
    return NextResponse.json({
      ok: true,
      msg: 'POST request working!',
      received: url,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
