// app/api/ingest/route.ts
import { NextResponse } from 'next/server';

// Simple health check so we know the route is wired up
export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

// keep Node runtime while we set up DB code later
export const runtime = 'nodejs';
