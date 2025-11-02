// app/api/ingest/route.ts
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

export async function POST(req: Request) {
  // we will fill this and return once at the end
  let finalResponse: any = null;

  try {
    console.log("Incoming ingestion request");

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
    await client.connect();

    // read body
    const body = await req.json();
console.log("Body received:", body);
    const text = body.text as string | undefined;
    const url = body.url as string | undefined;
    const sourceBucket =
      (body.sourceBucket as string | undefined) || "faq"; // default like before

    // ─────────────────────────────────────────────
    // CASE 1: TEXT INGEST (your google reviews)
    // ─────────────────────────────────────────────
    if (text && !url) {
      // create a fake, non-null url so postgres doesn't complain
      const docId = uuidv4();
      const fakeUrl = `text://${sourceBucket}/${docId}`;

      // insert into documents
console.log("Inserting document to Supabase");

      await client.query(
        `INSERT INTO documents (id, url, content, meta)
         VALUES ($1, $2, $3, $4)`,
        [docId, fakeUrl, text, JSON.stringify({ source: sourceBucket })]
      );
console.log("Creating embeddings for chunk");

      // now split text into chunks (very simple split; you can improve later)
      const MAX_CHARS = 1800;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += MAX_CHARS) {
        chunks.push(text.slice(i, i + MAX_CHARS));
      }

      for (const chunk of chunks) {
        // create embedding
        const embeddingRes = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: chunk,
        });

        const embedding = embeddingRes.data[0].embedding;
console.log("Inserting document to Supabase");

        await client.query(
          `INSERT INTO document_chunks
            (id, document_id, content, embedding, meta)
            VALUES ($1, $2, $3, $4, $5)`,
          [
            uuidv4(),
            docId,
            chunk,
            JSON.stringify(embedding),
            JSON.stringify({ source: sourceBucket }),
          ]
        );

console.log("Creating embeddings for chunk");

      }

      await client.end();

      finalResponse = {
        ok: true,
        message: "Reviews/text ingestion complete",
        source: sourceBucket,
        chunks: chunks.length,
      };
    }

    // ─────────────────────────────────────────────
    // CASE 2: URL INGEST (your original flow)
    // ─────────────────────────────────────────────
    else if (url) {
      // fetch & extract text from URL
      const res = await fetch(url);
      const html = await res.text();
      const $ = cheerio.load(html);
      const pageText = $("body").text().replace(/\s+/g, " ").trim();

      if (!pageText) {
        await client.end();
        return NextResponse.json(
          { ok: false, error: "Could not extract text from URL" },
          { status: 400 }
        );
      }

      const docId = uuidv4();
console.log("Inserting document to Supabase");

      await client.query(
        `INSERT INTO documents (id, url, content, meta)
         VALUES ($1, $2, $3, $4)`,
        [docId, url, pageText, JSON.stringify({ source: sourceBucket })]
      );
console.log("Creating embeddings for chunk");

      // simple chunking
      const MAX_CHARS = 1800;
      const chunks: string[] = [];
      for (let i = 0; i < pageText.length; i += MAX_CHARS) {
        chunks.push(pageText.slice(i, i + MAX_CHARS));
      }

      for (const chunk of chunks) {
        const embeddingRes = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: chunk,
        });
        const embedding = embeddingRes.data[0].embedding;
console.log("Inserting document to Supabase");

        await client.query(
          `INSERT INTO document_chunks
            (id, document_id, content, embedding, meta)
            VALUES ($1, $2, $3, $4, $5)`,
          [
            uuidv4(),
            docId,
            chunk,
            JSON.stringify(embedding),
            JSON.stringify({ source: sourceBucket }),
          ]
        );
console.log("Creating embeddings for chunk");

      }

      await client.end();

      finalResponse = {
        ok: true,
        message: "URL ingestion complete",
        url,
        chunks: chunks.length,
      };
    }

    // ─────────────────────────────────────────────
    // CASE 3: nothing given
    // ─────────────────────────────────────────────
    else {
      finalResponse = { ok: false, error: "No url or text provided" };
    }
  } catch (err: any) {
    console.error("Ingest error:", err);
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }

  // single exit
  return NextResponse.json(finalResponse);
}
