// app/api/ingest/route.ts
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

// tiny helper – fetch page and return plain text
async function fetchHtmlAsText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    // very simple text extractor
    return $("body").text().replace(/\s+/g, " ").trim();
  } catch (err) {
    console.error("fetchHtmlAsText error:", err);
    return null;
  }
}

// very simple chunker
function chunkText(text: string, size = 1500): string[] {
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

  // validate secret (like you were doing from curl / PowerShell)
  const incomingSecret = req.headers.get("x-ingest-secret");
  if (!incomingSecret || incomingSecret !== "a2x9s8d2lkfj39fdks9021x") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({} as any));
  const { url, text, sourceBucket } = body as {
    url?: string;
    text?: string;
    sourceBucket?: string;
  };

  // you said: sometimes we send only text (reviews), sometimes only url (old flow)
  if (!url && !text) {
    return NextResponse.json({ ok: false, error: "No url or text provided" }, { status: 400 });
  }

  const client = new Client({ connectionString: SUPABASE_CONN });
  await client.connect();

  try {
    // 1) decide the content we will store
    let fullText = text ?? "";

    if (url && !text) {
      const pageText = await fetchHtmlAsText(url);
      if (!pageText) {
        await client.end();
        return NextResponse.json(
          { ok: false, error: "Could not extract text from URL" },
          { status: 400 }
        );
      }
      fullText = pageText;
    }

    // 2) make a document id
    const docId = uuidv4();

    // 3) insert into documents – HERE we can store meta with source
    const meta = {
      source: sourceBucket ? sourceBucket : url ? "url" : "faq",
    };

    await client.query(
      `
      INSERT INTO documents (id, url, content, meta)
      VALUES ($1, $2, $3, $4)
    `,
      [docId, url ?? null, fullText, meta]
    );

    // 4) chunk the text
    const chunks = chunkText(fullText, 1500);

    // 5) insert chunks – WITHOUT meta, WITHOUT embedding (NULL)
    for (const chunk of chunks) {
      const chunkId = uuidv4();
      await client.query(
        `
        INSERT INTO document_chunks (id, document_id, content, embedding)
        VALUES ($1, $2, $3, $4)
      `,
        [chunkId, docId, chunk, null]
      );
    }

    await client.end();

    return NextResponse.json(
      {
        ok: true,
        message: "Ingestion complete",
        docId,
        chunks: chunks.length,
        source: meta.source,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Ingest error:", err);
    await client.end();
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
