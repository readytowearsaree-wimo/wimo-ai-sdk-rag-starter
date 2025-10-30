import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { JSDOM } from "jsdom";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

export async function POST(req: Request) {
  const secret = req.headers.get("x-ingest-secret");
  if (process.env.INGEST_SECRET && secret !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const url = body.url || body.sitemap;

  if (!url) {
    return NextResponse.json({ error: "Missing url or sitemap" }, { status: 400 });
  }

  try {
    const res = await fetch(url);
    const html = await res.text();
    const dom = new JSDOM(html);
    const text = dom.window.document.body.textContent || "";

    // Create embedding with OpenAI
    const embedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    });

    // Save to Supabase
    const { error } = await supabase.from("documents").insert([
      {
        url,
        title: dom.window.document.title,
        content: text.slice(0, 2000),
        embedding: embedding.data[0].embedding,
      },
    ]);

    if (error) throw error;

    return NextResponse.json({ success: true, url });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
