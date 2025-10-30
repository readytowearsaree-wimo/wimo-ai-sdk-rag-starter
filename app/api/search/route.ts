// app/api/search/route.ts
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import pkg from 'pg';

const { Client } = pkg;

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'search route is alive' });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? '').toString().trim();
    const topK = Math.min(Math.max(Number(body?.topK ?? 5), 1), 20);

    if (!query) {
      return NextResponse.json({ ok: false, error: 'Missing "query"' }, { status: 400 });
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

    // 1) embed user query
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(',')}]`;

    // 2) pull MORE rows than needed (to be able to pick only FAQs)
    const fetchCount = Math.max(topK * 4, 40);

    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    const sql = `
      select
        dc.document_id,
        d.url,
        dc.chunk_index,
        dc.content,
        1 - (dc.embedding <=> $1::vector) as similarity
      from document_chunks dc
      join documents d on d.id = dc.document_id
      order by dc.embedding <=> $1::vector
      limit $2;
    `;

    const { rows } = await client.query(sql, [vecLiteral, fetchCount]);
    await client.end();

    // small helper: is this row from FAQ?
    const mark = (url: string | null): boolean => {
      if (!url) return false;
      const u = url.toLowerCase();
      return (
        u.includes('/s/f/') ||
        u.includes('/faq') ||
        u.includes('/faqs-for-ready-to-wear-saree')
      );
    };

    // 3) split
    const faqRows = rows
      .filter(r => mark(r.url))
      .map(r => ({
        document_id: r.document_id,
        url: r.url,
        chunk_index: r.chunk_index,
        content: r.content,
        similarity: Number(r.similarity) || 0,
        sourceBucket: 'faq',
      }))
      .sort((a, b) => b.similarity - a.similarity);

    const otherRows = rows
      .filter(r => !mark(r.url))
      .map(r => ({
        document_id: r.document_id,
        url: r.url,
        chunk_index: r.chunk_index,
        content: r.content,
        similarity: Number(r.similarity) || 0,
        sourceBucket: 'other',
      }))
      .sort((a, b) => b.similarity - a.similarity);

    let finalResults;
    if (faqRows.length > 0) {
      // STRICT RULE: show FAQs first, then fill with others if not enough
      finalResults = [...faqRows.slice(0, topK)];
      if (finalResults.length < topK) {
        const needed = topK - finalResults.length;
        finalResults = finalResults.concat(otherRows.slice(0, needed));
      }
    } else {
      // no faq found → just return the best matches
      finalResults = [...otherRows.slice(0, topK)];
    }

    return NextResponse.json({
      ok: true,
      query,
      results: finalResults,
    });
  } catch (err: any) {
    console.error('Search error:', err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
