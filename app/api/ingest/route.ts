// app/api/ingest/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';
const { Client } = pkg;

// Helper: split large text into chunks
function chunkText(text: string, maxLen = 4000) {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

// Helper: fetch and extract clean text from a URL
async function fetchHtmlAsText(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script,noscript,nav,footer,style').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text;
}

// Healthcheck
export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive ✅' });
}

// POST: handle sitemap or single-page ingestion
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as any;

    // ✅ Secret check (security)
    const secretHeader = req.headers.get('x-ingest-secret');
    const expectedSecret = process.env.INGEST_SECRET;

    console.log('🔒 Incoming secret:', secretHeader);
    console.log('🔑 Expected secret:', expectedSecret);

    if (!expectedSecret) {
      console.error('❌ Missing INGEST_SECRET in environment');
      return NextResponse.json(
        { ok: false, error: 'missing server secret' },
        { status: 500 }
      );
    }

    if (secretHeader !== expectedSecret) {
      console.error('❌ Secret mismatch');
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    // ✅ Handle inputs
    const sitemapUrl =
      body.sitemapUrl || body.sitemapurl || body.sitemap || body.siteMapUrl;
    const singleUrl = body.url;

    if (!sitemapUrl && !singleUrl) {
      return NextResponse.json({ ok: false, error: 'No URL provided' });
    }

    const client = new Client({
      connectionString: process.env.SUPABASE_CONN,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const mode = sitemapUrl ? 'sitemap' : 'single';

    // ✅ If sitemap ingestion
    if (sitemapUrl) {
      console.log(`📄 Fetching sitemap: ${sitemapUrl}`);
      const sitemapRes = await fetch(sitemapUrl);
      const sitemapXml = await sitemapRes.text();
      const $ = cheerio.load(sitemapXml, { xmlMode: true });
      const locs = $('loc')
        .map((_, el) => $(el).text())
        .get();

      console.log(`Found ${locs.length} URLs in sitemap.`);

      let success = 0;
      let fail = 0;

      for (const loc of locs) {
        try {
          const text = await fetchHtmlAsText(loc);
          const chunks = chunkText(text);
          for (const chunk of chunks) {
            const embedding = await openai.embeddings.create({
              model: 'text-embedding-3-small',
              input: chunk,
            });
            const vector = embedding.data[0].embedding;

            await client.query(
              `INSERT INTO documents (id, url, content, embedding)
               VALUES ($1, $2, $3, $4)`,
              [uuidv4(), loc, chunk, vector]
            );
          }
          success++;
        } catch (err) {
          console.error(`❌ Failed to ingest ${loc}`, err);
          fail++;
        }
      }

      await client.end();
      return NextResponse.json({
        ok: true,
        mode,
        sitemapUrl,
        ingested: success,
        failed: fail,
      });
    }

    // ✅ If single page ingestion
    if (singleUrl) {
      console.log(`🧩 Ingesting single URL: ${singleUrl}`);
      const text = await fetchHtmlAsText(singleUrl);
      const chunks = chunkText(text);

      for (const chunk of chunks) {
        const embedding = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: chunk,
        });
        const vector = embedding.data[0].embedding;

        await client.query(
          `INSERT INTO documents (id, url, content, embedding)
           VALUES ($1, $2, $3, $4)`,
          [uuidv4(), singleUrl, chunk, vector]
        );
      }

      await client.end();
      return NextResponse.json({
        ok: true,
        mode,
        url: singleUrl,
        ingested: chunks.length,
      });
    }
  } catch (error) {
    console.error('❌ Ingest error:', error);
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
