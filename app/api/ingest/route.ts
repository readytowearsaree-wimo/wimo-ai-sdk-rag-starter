import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import pkg from "pg";

const { Client } = pkg;

export async function POST(req: Request) {
  try {
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

    const body = await req.json();
    const { url, text } = body;

    // ✅ Must have either URL or text
    if (!url && !text) {
      await client.end();
      return NextResponse.json(
        { ok: false, error: "No url or text provided" },
        { status: 400 }
      );
    }

    let content = "";

    // ✅ If text provided, use directly
    if (text) {
      content = text;
    } else if (url) {
      // ✅ Fetch & extract HTML text
      const res = await fetch(url);
      const html = await res.text();
      const $ = cheerio.load(html);
      $("script,style,noscript,nav,footer").remove();
      content = $("body").text().replace(/\s+/g, " ").trim();
    }

    if (!content) {
      await client.end();
      return NextResponse.json(
        { ok: false, error: "Empty content after processing" },
        { status: 400 }
      );
    }

    const docId = uuidv4();

    // ✅ Insert document into Supabase
    const insertQuery = `
      INSERT INTO documents (id, content, meta, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING id;
    `;
    const meta = { source: url ? "faq" : "google-review" };
    await client.query(insertQuery, [docId, content, meta]);

    await client.end();

    return NextResponse.json({
      ok: true,
      message: url ? "FAQ ingestion complete" : "Reviews/text ingestion complete",
      source: meta.source,
      characters: content.length,
    });
  } catch (err: any) {
    console.error("Ingest error:", err);
    return NextResponse.json(
      { ok: false, error: err.message || String(err) },
      { status: 500 }
    );
  }
}
