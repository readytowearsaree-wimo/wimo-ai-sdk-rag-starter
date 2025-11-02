// app/api/ingest/route.ts
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import pkg from "pg";

const { Client } = pkg;

export async function POST(req: Request) {
  const secret = req.headers.get("x-ingest-secret");
  if (!secret || secret !== "a2x9s8d2lkfj39fdks9021x") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({} as any));
  const { text, url, sourceBucket } = body as {
    text?: string;
    url?: string;
    sourceBucket?: string;
  };

  if (!text && !url) {
    return NextResponse.json({ ok: false, error: "No url or text provided" }, { status: 400 });
  }

  const SUPABASE_CONN = process.env.SUPABASE_CONN;
  if (!SUPABASE_CONN) {
    return NextResponse.json({ ok: false, error: "No DB conn" }, { status: 500 });
  }

  const client = new Client({ connectionString: SUPABASE_CONN });
  await client.connect();

  const docId = uuidv4();
  const content = text ?? "";
  const meta = {
    source: sourceBucket ?? "google-review",
  };

  try {
    await client.query(
      `
      INSERT INTO documents (id, url, content, meta)
      VALUES ($1, $2, $3, $4)
      `,
      [docId, url ?? null, content, meta]
    );

    await client.end();
    return NextResponse.json(
      {
        ok: true,
        message: "Inserted into documents only",
        docId,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("DB error:", err);
    await client.end();
    return NextResponse.json(
      {
        ok: false,
        error: String(err?.message || err),
      },
      { status: 500 }
    );
  }
}
