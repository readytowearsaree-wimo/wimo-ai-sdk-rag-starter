// app/api/ingest/route.ts
export const runtime = 'node';

import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';
const { Client } = pkg;

// ─── helpers ───────────────────────────────────────────────

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

// parse a simple XML sitemap that has <url><loc>...</loc></url>
async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  const res = await fetch(sitemapUrl, { cache: 'no-store' });
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  // two cases:
  // 1) sitemapindex -> sub-sitemaps
  // 2) urlset -> actual pages
  const sitemapLocs: string[] = [];
  $('sitemap > loc').each((_, el) => {
    sitemapLocs.push($(el).text().trim());
  });

  if (sitemapLocs.length > 0) {
    // it's a sitemap index → return those sitemaps
    return sitemapLocs;
  }

  // otherwise get page URLs
  const pageUrls: string[] = [];
  $('url > loc').each((_, el) => {
    pageUrls.push($(el).text().trim());
  });

  return pageUrls;
}

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

export async function POST(req: Request) {
  try {
    // read body first
    const body = (await req.json().catch(() => ({}))) as any;

    // ── secret check (must match Vercel env) ──
    const headerSecret = req.headers.get('x-ingest-secret');
    const expectedSecret = process.env.INGEST_SECRET;
    if (expectedSecret && headerSecret !== expectedSecret) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    // allow several keys
    const sitemapUrl: string | undefined =
      body.sitemapUrl || body.sitemapurl || body.sitemap || body.siteMapUrl;
    const singleUrl: string | undefined = body.url;

    // limit per run
    const maxUrls: number = typeof body.maxUrls === 'number' ? body.maxUrls : 20;

    // envs
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN = process.env.SUPABASE_CONN;
    if (!OPENAI_API_KEY || !SUPABASE_CONN) {
      return NextResponse.json(
        { ok: false, error: 'Missing OPENAI_API_KEY or SUPABASE_CONN' },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    // ─────────────────────────────────────────
    // 1) single-page ingestion
    // ─────────────────────────────────────────
    if (singleUrl) {
      const result = await ingestOneUrl(singleUrl, openai, client);
      await client.end();
      return NextResponse.json({
        ok: true,
        mode: 'single',
        url: singleUrl,
        ...result,
      });
    }

    // ─────────────────────────────────────────
    // 2) sitemap ingestion (with limit)
    // ─────────────────────────────────────────
    if (sitemapUrl) {
      // could be either a sitemap-index or a urlset
      const urls = await fetchSitemapUrls(sitemapUrl);

      // if it returned sub-sitemaps (index), just return them
      // the idea is: call this API again for EACH of those
      if (urls.length && urls[0].endsWith('.xml')) {
        await client.end();
        return NextResponse.json({
          ok: true,
          mode: 'sitemap-index',
          sitemapUrl,
          subSitemaps: urls,
          note: 'Call /api/ingest again with each of these',
        });
      }

      // otherwise, we have actual page URLs
      const slice = urls.slice(0, maxUrls);
      const ingested: string[] = [];
      const failed: { url: string; error: string }[] = [];

      for (const pageUrl of slice) {
        try {
          const r = await ingestOneUrl(pageUrl, openai, client);
          if (r.ok) {
            ingested.push(pageUrl);
          } else {
            failed.push({ url: pageUrl, error: r.error || 'unknown' });
          }
        } catch (e: any) {
          failed.push({ url: pageUrl, error: e?.message || String(e) });
        }
      }

      await client.end();
      return NextResponse.json({
        ok: true,
        mode: 'sitemap',
        sitemapUrl,
        countInThisRun: slice.length,
        ingested: ingested.length,
        failed,
        moreAvailable: urls.length > slice.length,
      });
    }

    // nothing provided
    await client.end();
    return NextResponse.json({ ok: false, error: 'No URL provided' }, { status: 400 });
  } catch (err: any) {
    console.error('Ingest error:', err);
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}

// ─── core ingestion for ONE url ────────────────────────────
async function ingestOneUrl(
  url: string,
  openai: OpenAI,
  client: any
): Promise<{ ok: boolean; error?: string; chunks?: number }> {
  // fetch text
  const text = await fetchHtmlAsText(url);
  if (!text) {
    return { ok: false, error: 'No content extracted from URL' };
  }

  const docId = uuidv4();

  // insert / upsert document (no "meta" col now)
  await client.query(
    `insert into documents (id, url, content)
     values ($1, $2, $3)
     on conflict (url) do update set content = excluded.content`,
    [docId, url, text]
  );

  // remove old chunks
  await client.query(`delete from document_chunks where document_id = $1`, [docId]);

  const chunks = chunkText(text);
  let idx = 0;
  for (const chunk of chunks) {
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: chunk,
    });

    const vector = emb.data[0].embedding;

    // IMPORTANT: pass as JSON array, Postgres will coerce to vector via extension
    await client.query(
      `insert into document_chunks (id, document_id, chunk_index, content, embedding)
       values ($1, $2, $3, $4, $5)`,
      [uuidv4(), docId, idx, chunk, vector]
    );
    idx++;
  }

  return { ok: true, chunks: chunks.length };
}
