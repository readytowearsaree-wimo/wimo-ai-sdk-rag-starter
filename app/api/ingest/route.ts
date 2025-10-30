// app/api/ingest/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import pkg from 'pg';
const { Client } = pkg;

// split big text
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

// GET = healthcheck
export async function GET() {
  return NextResponse.json({ ok: true, msg: 'ingest route is alive' });
}

// POST = single page or sitemap
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));

    // accept multiple spellings
    const sitemapUrl =
      body.sitemapUrl || body.sitemapurl || body.sitemap || body.siteMapUrl;
    const singleUrl = body.url;

    // small debug to Vercel logs
    console.log('INGEST BODY RECEIVED:', body);

    if (!sitemapUrl && !singleUrl) {
      return NextResponse.json(
        { ok: false, error: 'No URL provided' },
        { status: 400 }
      );
    }

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

    // ensure table shape
    await client.query(`
      create table if not exists documents (
        id uuid primary key,
        url text unique,
        content text,
        created_at timestamptz default now()
      );
    `);
    await client.query(`
      create table if not exists document_chunks (
        id uuid primary key,
        document_id uuid references documents(id) on delete cascade,
        chunk_index int,
        content text,
        embedding vector(1536)
      );
    `);

    // ------------- SITEMAP PATH -------------
    if (sitemapUrl) {
      const sitemapRes = await fetch(sitemapUrl);
      const sitemapXml = await sitemapRes.text();

      // very simple sitemap parser
      const urls: string[] = [];
      const $ = cheerio.load(sitemapXml, { xmlMode: true });
      $('url > loc').each((_, el) => {
        const u = $(el).text().trim();
        if (u) urls.push(u);
      });

      let okCount = 0;
      let failCount = 0;

      for (const pageUrl of urls) {
        try {
          const text = await fetchHtmlAsText(pageUrl);
          if (!text) continue;

          const docId = uuidv4();
          // insert or update
          const upsertResult = await client.query(
            `
              insert into documents (id, url, content)
              values ($1, $2, $3)
              on conflict (url) do update set content = excluded.content
              returning id;
            `,
            [docId, pageUrl, text]
          );

          const finalDocId = upsertResult.rows[0]?.id || docId;

          // delete old chunks
          await client.query(
            `delete from document_chunks where document_id = $1`,
            [finalDocId]
          );

          const chunks = chunkText(text);
          for (let i = 0; i < chunks.length; i++) {
            const emb = await openai.embeddings.create({
              model: 'text-embedding-3-small',
              input: chunks[i],
            });
            const vector = emb.data[0].embedding;

            await client.query(
              `
                insert into document_chunks
                  (id, document_id, chunk_index, content, embedding)
                values ($1, $2, $3, $4, $5)
              `,
              [uuidv4(), finalDocId, i, chunks[i], vector]
            );
          }

          okCount++;
        } catch (e) {
          console.error('Failed to ingest page from sitemap:', pageUrl, e);
          failCount++;
        }
      }

      await client.end();
      return NextResponse.json({
        ok: true,
        mode: 'sitemap',
        sitemapUrl,
        ingested: okCount,
        failed: failCount,
      });
    }

    // ------------- SINGLE URL PATH -------------
    if (singleUrl) {
      const text = await fetchHtmlAsText(singleUrl);

      const docId = uuidv4();
      const upsertResult = await client.query(
        `
          insert into documents (id, url, content)
          values ($1, $2, $3)
          on conflict (url) do update set content = excluded.content
          returning id;
        `,
        [docId, singleUrl, text]
      );
      const finalDocId = upsertResult.rows[0]?.id || docId;

      await client.query(
        `delete from document_chunks where document_id = $1`,
        [finalDocId]
      );

      const chunks = chunkText(text);
      for (let i = 0; i < chunks.length; i++) {
        const emb = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: chunks[i],
        });
        const vector = emb.data[0].embedding;
        await client.query(
          `
            insert into document_chunks
              (id, document_id, chunk_index, content, embedding)
            values ($1, $2, $3, $4, $5)
          `,
          [uuidv4(), finalDocId, i, chunks[i], vector]
        );
      }

      await client.end();
      return NextResponse.json({
        ok: true,
        mode: 'single',
        url: singleUrl,
        chunks: chunks.length,
      });
    }

    // fallback
    await client.end();
    return NextResponse.json({ ok: false, error: 'nothing ingested' });
  } catch (err: any) {
    console.error('INGEST ERROR', err);
    return NextResponse.json(
      { ok: false, error: err.message || String(err) },
      { status: 500 }
    );
  }
}
