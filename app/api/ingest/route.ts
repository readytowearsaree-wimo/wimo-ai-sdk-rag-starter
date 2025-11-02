// app/api/ingest/route.ts
import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';

const { Client } = pkg;

// split helper for long strings
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
  const res = await fetch(url, { cache: 'no-store' });
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,footer').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text;
}

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { url, text } = body;

  if (!url && !text) {
    return NextResponse.json({ ok: false, error: "No url or text provided" }, { status: 400 });
  }

  let content = "";

  if (url) {
    // Fetch HTML and extract text content if URL provided
    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, noscript, nav, footer").remove();
    content = $("body").text().replace(/\s+/g, " ").trim();
  } else if (text) {
    // Directly use the provided text input
    content = text;
  }

  if (!content) {
    return NextResponse.json({ ok: false, error: "Empty content" }, { status: 400 });
  }

  // Create document
  const { data, error } = await supabase
    .from("documents")
    .insert({
      content,
      meta: { source: url ? "url" : "google-review" }
    })
    .select("*");

  if (error) {
    console.error(error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, data });
}


    const body = await req.json().catch(() => ({} as any));
    const { url, text } = body as { url?: string; text?: string };

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json(
        { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
        { status: 400 }
      );
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // CASE 1: ingest plain text (our reviews.txt case)
    if (text && !url) {
      // split by ---- so each review is one doc
      const blocks = text
        .split('----')
        .map((b) => b.trim())
        .filter(Boolean);

      let inserted = 0;

      for (const block of blocks) {
        const docId = uuidv4();

        // insert into documents
        await client.query(
          `insert into documents (id, url, content, meta)
           values ($1, $2, $3, $4)`,
          [
            docId,
            // no real url → put a tag
            `review://${docId}`,
            block,
            { source: 'google-review' },
          ]
        );

        // make embedding
        const emb = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: block,
        });

        const vector = emb.data[0].embedding;

        await client.query(
          `insert into document_chunks (id, document_id, chunk_index, content, embedding)
           values ($1, $2, $3, $4, $5)`,
          [uuidv4(), docId, 0, block, vector]
        );

        inserted++;
      }

      await client.end();
      return NextResponse.json({
        ok: true,
        message: 'Reviews/text ingestion complete',
        blocks: inserted,
      });
    }

    // CASE 2: ingest by URL (your earlier flow)
    if (!url) {
      await client.end();
      return NextResponse.json({ ok: false, error: 'No url or text provided' }, { status: 400 });
    }

    const pageText = await fetchHtmlAsText(url);
    if (!pageText) {
      await client.end();
      return NextResponse.json({ ok: false, error: 'Could not extract text from URL' }, { status: 400 });
    }

    const docId = uuidv4();
    await client.query(
      `insert into documents (id, url, content, meta)
       values ($1, $2, $3, $4)
       on conflict (url) do update set content=excluded.content`,
      [docId, url, pageText, { source: 'web' }]
    );

    // remove old chunks for this document
    await client.query(`delete from document_chunks where document_id=$1`, [docId]);

    const chunks = chunkText(pageText);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const emb = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk,
      });
      const vector = emb.data[0].embedding;
      await client.query(
        `insert into document_chunks (id, document_id, chunk_index, content, embedding)
         values ($1, $2, $3, $4, $5)`,
        [uuidv4(), docId, i, chunk, vector]
      );
    }

    await client.end();
    return NextResponse.json({
      ok: true,
      message: 'URL ingestion complete',
      url,
      chunks: chunks.length,
    });
  } catch (err: any) {
    console.error('Ingest error:', err);
    return NextResponse.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
