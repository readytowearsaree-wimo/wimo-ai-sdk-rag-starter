import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import pkg from "pg";

const { Client } = pkg;

// very dumb chunker: split every 800 chars
function chunkText(text: string, size = 800): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

export async function POST(req: Request) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const SUPABASE_CONN = process.env.SUPABASE_CONN;

  if (!OPENAI_API_KEY || !SUPABASE_CONN) {
    return NextResponse.json(
      { ok: false, error: "Missing OPENAI_API_KEY or SUPABASE_CONN" },
      { status: 400 }
    );
  }

  const client = new Client({ connectionString: SUPABASE_CONN });
  await client.connect();

  try {
    const body = await req.json();
    const { url, text, sourceBucket } = body as {
      url?: string;
      text?: string;
      sourceBucket?: string;
    };

    // ----- CASE 1: plain text (what we're doing for Google reviews) -----
    if (text && !url) {
      const docId = uuidv4();

      // 1) insert into documents
      await client.query(
        `INSERT INTO documents (id, url, content, meta)
         VALUES ($1, $2, $3, $4)`,
        [
          docId,
          null,
          text,
          { source: sourceBucket ?? "google-review" }, // stays jsonb
        ]
      );

      // 2) make chunks
      const chunks = chunkText(text, 800);

      let chunkIndex = 0;
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO document_chunks
             (id, document_id, chunk_index, content, embedding, meta)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            uuidv4(),     // id
            docId,        // document_id
            chunkIndex,   // chunk_index
            chunk,        // content
            null,         // embedding - to be filled later
            { source: sourceBucket ?? "google-review" }, // meta
          ]
        );
        chunkIndex += 1;
      }

      await client.end();
      return NextResponse.json({
        ok: true,
        message: "Inserted text + chunks",
        chunks: chunkIndex,
        docId,
      });
    }

    // ----- CASE 2: URL ingestion (your older path) -----
    if (!url && !text) {
      await client.end();
      return NextResponse.json(
        { ok: false, error: "No url or text provided" },
        { status: 400 }
      );
    }

    // ... your older URL flow here ...

    await client.end();
    return NextResponse.json({ ok: true, message: "URL ingestion complete" });
  } catch (err: any) {
    console.error("Ingest error:", err);
    await client.end();
    return NextResponse.json(
      { ok: false, error: String(err.message || err) },
      { status: 500 }
    );
  }
}
