// app/api/ingest/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';

const { Client } = pkg;

// split text
function chunkText(text: string, maxLen = 4000) {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

// fetch HTML → text
async function fetchHtmlAsText(url: string) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`fetch failed for ${url}: ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,footer').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return text;
}

/**
 * Fetch a sitemap URL.
 * - If it is a normal urlset → return that list
 * - If it is a sitemapindex → fetch each child sitemap and aggregate all urls
 */
async function fetchSitemapUrlsDeep(sitemapUrl: string): Promise<string[]> {
  const res = await fetch(sitemapUrl, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`sitemap fetch failed: ${res.status}`);
  }
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  // 1) try normal <urlset>
  const pageUrls: string[] = [];
  $('url > loc').each((i, el) => {
    const loc = $(el).text().trim();
    if (loc) pageUrls.push(loc);
  });
  if (pageUrls.length > 0) {
    return pageUrls;
  }

  // 2) if no <url>, maybe it's a sitemapindex → collect child sitemaps
  const sitemapUrls: string[] = [];
  $('sitemap > loc').each((i, el) => {
    const loc = $(el).text().trim();
    if (loc) sitemapUrls.push(loc);
  });

  if (sitemapUrls.length === 0) {
    // nothing we can do
    return [];
  }

  // 3) fetch each child sitemap and collect their urls
  const all: string[] = [];
  for (const child of sitemapUrls) {
    try {
      const childUrls = await fetchSitemapUrlsDeep(child);
      all.push(...childUrls);
    } catch (err) {
      console.error('child sitemap failed', child, err);
    }
  }
  return all;
}

// simple GET
export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as any;

    // allow several keys
    const sitemapUrl =
      body.sitemapUrl || body.sitemapurl || body.sitemap || body.siteMapUrl;
    const singleUrl = body.url;

    // secret check
    const secretHeader = req.headers.get('x-ingest-secret');
    const expectedSecret = process.env.INGEST_SECRET;
    if (expectedSecret && secretHeader !== expectedSecret) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json(
        { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
        { status: 500 }
      );
    }

    // helper: ingest ONE page
    const ingestOne = async (pageUrl: string) => {
      const client = new Client({ connectionString: SUPABASE_CONN });
      await client.connect();

      const text = await fetchHtmlAsText(pageUrl);
      if (!text) {
        await client.end();
        return { ok: false, error: 'no text', url: pageUrl };
      }

      const docId = uuidv4();

      // your documents table has NO "meta" column, so just id/url/content
      await client.query(
        `
        insert into documents (id, url, content)
        values ($1, $2, $3)
        on conflict (url) do update set content = excluded.content
        `,
        [docId, pageUrl, text]
      );

      await client.query('delete from document_chunks where document_id = $1', [docId]);

      const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
      const chunks = chunkText(text);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const emb = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: chunk,
        });
        const vector = emb.data[0].embedding;

        await client.query(
          `
          insert into document_chunks (id, document_id, chunk_index, content, embedding)
          values ($1, $2, $3, $4, $5::vector)
          `,
          [uuidv4(), docId, i, chunk, JSON.stringify(vector)]
        );
      }

      await client.end();
      return { ok: true, url: pageUrl, chunks: chunks.length };
    };

    // --------------- SITEMAP MODE ---------------
    if (sitemapUrl) {
      const allUrls = await fetchSitemapUrlsDeep(sitemapUrl);

      let ingested = 0;
      let failed = 0;

      // do sequential first (safe for your small Supabase)
      for (const u of allUrls) {
        try {
          await ingestOne(u);
          ingested++;
        } catch (err) {
          console.error('ingest failed for', u, err);
          failed++;
        }
      }

      return NextResponse.json({
        ok: true,
        mode: 'sitemap',
        sitemapUrl,
        found: allUrls.length,
        ingested,
        failed,
      });
    }

    // --------------- SINGLE URL MODE ---------------
    if (singleUrl) {
      const res = await ingestOne(singleUrl);
      return NextResponse.json(res);
    }

    return NextResponse.json({ ok: false, error: 'No URL provided' }, { status: 400 });
  } catch (err: any) {
    console.error('Ingest error:', err);
    return NextResponse.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
