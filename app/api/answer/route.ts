// app/api/answer/route.ts
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import pkg from 'pg';

const { Client } = pkg;

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const userMessage = (body?.message ?? '').toString().trim();
    const topK = Math.min(Math.max(Number(body?.topK ?? 3), 1), 10);

    if (!userMessage) {
      return NextResponse.json({ ok: false, error: 'Missing message' }, { status: 400 });
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

    // 1) embed the user question
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: userMessage,
    });
    const queryEmbedding = emb.data[0].embedding;
    const vecLiteral = `[${queryEmbedding.join(',')}]`;

    // 2) fetch FAQ chunks from db
    const client = new Client({ connectionString: SUPABASE_CONN });
    await client.connect();

    const sql = `
      select
        dc.document_id,
        dc.content,
        d.url,
        d.meta,
        1 - (dc.embedding <=> $1::vector) as similarity
      from document_chunks dc
      join documents d on d.id = dc.document_id
      order by dc.embedding <=> $1::vector
      limit $2;
    `;

    const { rows } = await client.query(sql, [vecLiteral, topK]);
    await client.end();

    const contextBlocks = rows.map((r, i) => `### Chunk ${i + 1}\n${r.content}`).join('\n\n');

    // 3) ask OpenAI to answer from context
    const systemPrompt = `
You are WiMO Ready-to-Wear Saree assistant.
Answer ONLY from the context below (they are FAQs). 
If you don't find the answer, say "I don't find this in WiMO FAQs" and tell the user to WhatsApp.
Be concise, friendly, and keep brand tone.
    `.trim();

    const userPrompt = `
User question: ${userMessage}

Context:
${contextBlocks}
    `.trim();

    const chat = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    });

    const answer = chat.choices[0]?.message?.content ?? 'No answer generated.';

    return NextResponse.json({
      ok: true,
      answer,
      sources: rows.map(r => ({
        url: r.url,
        similarity: Number(r.similarity),
      })),
    });
  } catch (err: any) {
    console.error('answer error:', err);
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}
