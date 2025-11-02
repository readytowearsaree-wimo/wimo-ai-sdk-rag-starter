import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

// simple helper to split long text into chunks
function chunkText(text: string, max = 1200): string[] {
  const parts: string[] = [];
  let current = text.trim();

  while (current.length > max) {
    // try to break on a sentence
    let idx =
      current.lastIndexOf(".", max) > 0
        ? current.lastIndexOf(".", max) + 1
        : max;
    parts.push(current.slice(0, idx).trim());
    current = current.slice(idx).trim();
  }

  if (current.length) parts.push(current);
  return parts;
}

// fetch HTML and turn into plain text (your earlier flow)
async function fetchHtmlAsText(url: string): Promise<string | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const html = await res.text();
  const $ = cheerio.load(html);
  return $("body").text().replace(/\s+/g, " ").trim();
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

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const client = new Client({ connectionString: SUPABASE_CONN });

  try {
    await client.connect();

    // 1) read body
    const body = await req.json().catch(() => ({}));
    const url: string | undefined = body.url;
    const text: string | undefined = body.text;
    const sourceBucket: string = body.sourceBucket || "faq";

    // we need at least one of them
    if (!url && !text) {
      await client.end();
      return NextResponse.json(
        { ok: false, error: "No url or text provided" },
        { status: 400 }
      );
    }

    // =====================================================================
    // CASE 1: RAW TEXT INGEST (this is what we use for Google reviews)
    // =====================================================================
    if (text) {
      const docId = uuidv4();

      // you don’t have a real url for reviews, so we store a fake/marker url
      const fakeUrl = `text://google-reviews/${docId}`;

      // insert into documents
      await client.query(
        `INSERT INTO documents (id, url, content, meta)
         VALUES ($1, $2, $3, $4)`,
        [docId, fakeUrl, text, JSON.stringify({ source: sourceBucket })]
      );

      // chunk and embed
      const chunks = chunkText(text);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        const embedding = await openai.embeddings.create({
          model: "text-embedding-3-large",
          input: chunk,
        });

        await client.query(
          `INSERT INTO document_chunks
             (id, document_id, content, embedding, meta)
           VALUES ($1, $2, $3, $4::vector, $5)`,
          [
            uuidv4(),
            docId,
            chunk,
            embedding.data[0].embedding,
            JSON.stringify({
              source: sourceBucket,
              chunk_index: i,
            }),
          ]
        );
      }

      await client.end();
      return NextResponse.json({
        ok: true,
        message: "Text / reviews ingestion complete",
        chunks: chunks.length,
        document_id: docId,
      });
    }

    // =====================================================================
    // CASE 2: URL INGEST (your original flow)
    // =====================================================================
    if (url) {
      const pageText = await fetchHtmlAsText(url);
      if (!pageText) {
        await client.end();
        return NextResponse.json(
          { ok: false, error: "Could not extract text from URL" },
          { status: 400 }
        );
      }

      const docId = uuidv4();

      await client.query(
        `INSERT INTO documents (id, url, content, meta)
         VALUES ($1, $2, $3, $4)`,
        [docId, url, pageText, JSON.stringify({ source: sourceBucket })]
      );

      const chunks = chunkText(pageText);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        const embedding = await openai.embeddings.create({
          model: "text-embedding-3-large",
          input: chunk,
        });

        await client.query(
          `INSERT INTO document_chunks
             (id, document_id, content, embedding, meta)
           VALUES ($1, $2, $3, $4::vector, $5)`,
          [
            uuidv4(),
            docId,
            chunk,
            embedding.data[0].embedding,
            JSON.stringify({
              source: sourceBucket,
              chunk_index: i,
              from_url: url,
            }),
          ]
        );
      }

      await client.end();
      return NextResponse.json({
        ok: true,
        message: "URL ingestion complete",
        url,
        chunks: chunks.length,
        document_id: docId,
      });
    }

    // fallback — we should never reach here
    await client.end();
    return NextResponse.json(
      { ok: false, error: "Nothing ingested" },
      { status: 400 }
    );
  } catch (err: any) {
    console.error("Ingest error:", err);
    try {
      await new Client({ connectionString: process.env.SUPABASE_CONN! }).end();
    } catch (e) {
      // ignore
    }
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  } finally {
    //  this is the fix for the pool-limits issue
    await client.end();
  }
}
