// app/api/ingest/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';

const { Client } = pkg;

// split a big text into chunks
function chunkText(text: string, maxLen = 4000) {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

// fetch HTML → clean → text
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

// fetch and parse sitemap.xml → list of URLs
async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  const res = await fetch(sitemapUrl, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`sitemap fetch failed: ${res.status}`);
  }
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  const urls: string[] = [];
  $('url > loc').each((i, el) => {
    const loc = $(el).text().trim();
    if (loc) urls.push(loc);
  });

  // some sites use sitemapindex → sitemap -> loc
  if (urls.length === 0) {
    const indexUrls: string[] = [];
    $('sitemap > loc').each((i, el) => {
      const loc = $(el).text().trim();
      if (loc) indexUrls.push(loc);
    });
    // if you have sitemap index, we could fetch each again — but for now just return what we found
    return indexUrls;
  }

  return urls;
}

// GET – health check
export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

// POST – ingest single URL or full sitemap
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as any;

    // accept multiple keys
    const sitemapUrl =
      body.sitemapUrl || body.sitemapurl || body.sitemap || body.siteMapUrl;
    const singleUrl = body.url;

    // simple secret check (same as your curl header)
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

    // helper to ingest ONE page
    const ingestOne = async (pageUrl: string) => {
      const client = new Client({ connectionString: SUPABASE_CONN });
      await client.connect();

      const text = await fetchHtmlAsText(pageUrl);
      if (!text) {
        await client.end();
        return { ok: false, error: 'no text', url: pageUrl };
      }

      // insert into documents first (no meta column in your DB)
      const docId = uuidv4();
      await client.query(
        `
        insert into documents (id, url, content)
        values ($1, $2, $3)
        on conflict (url) do update set content = excluded.content
        `,
        [docId, pageUrl, text]
      );

      // delete old chunks for this doc
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

        // IMPORTANT: cast array → vector in SQL
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

    // CASE 1: sitemap
    if (sitemapUrl) {
      const urls = await fetchSitemapUrls(sitemapUrl);
      let ingested = 0;
      let failed = 0;

      // keep it serial for now (simpler, less Supabase load)
      for (const u of urls) {
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
        ingested,
        failed,
      });
    }

    // CASE 2: single url
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
