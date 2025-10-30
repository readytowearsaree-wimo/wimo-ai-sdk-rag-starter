// app/api/ingest/route.ts
import { NextResponse } from "next/server";
import cheerio from "cheerio";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import pkg from "pg";
import xml2js from "xml2js";

const { Client } = pkg;

// Split text into ~4000-char chunks
function chunkText(text: string, maxLen = 4000) {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

async function fetchHtmlAsText(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  const html = await res.text();
  const $ = cheerio.load(html);
  $("script,style,noscript,nav,footer").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return text;
}

export async function GET() {
  return NextResponse.json({ ok: true, msg: "ingest route ready" });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const sitemapUrl = body.sitemapUrl;
    const singleUrl = body.url;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN)
      return NextResponse.json(
        { ok: false, error: "Missing keys" },
        { status: 400 }
      );

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    const urls: string[] = [];

    if (sitemapUrl) {
      const res = await fetch(sitemapUrl);
      const xml = await res.text();
      const parsed = await xml2js.parseStringPromise(xml);
      for (const entry of parsed.urlset.url) {
        urls.push(entry.loc[0]);
      }
    } else if (singleUrl) {
      urls.push(singleUrl);
    } else {
      return NextResponse.json(
        { ok: false, error: "Need url or sitemapUrl" },
        { status: 400 }
      );
    }

    let totalChunks = 0;
    for (const url of urls) {
      const text = await fetchHtmlAsText(url);
      if (!text) continue;

      const docId = uuidv4();
      await client.query(
        `insert into documents (id, url, content, meta)
         values ($1, $2, $3, $4)
         on conflict (url) do update set content=excluded.content`,
        [docId, url, text, { source: "web" }]
      );

      await client.query(`delete from document_chunks where document_id=$1`, [
        docId,
      ]);

      const chunks = chunkText(text);
      for (let i = 0; i < chunks.length; i++) {
        const emb = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: chunks[i],
        });
        const vector = emb.data[0].embedding;
        await client.query(
          `insert into document_chunks (id, document_id, chunk_index, content, embedding)
           values ($1,$2,$3,$4,$5)`,
          [uuidv4(), docId, i, chunks[i], vector]
        );
      }
      totalChunks += chunks.length;
    }

    await client.end();
    return NextResponse.json({
      ok: true,
      message: "Ingestion complete",
      pages: urls.length,
      totalChunks,
    });
  } catch (err: any) {
    console.error("Ingest error:", err);
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
