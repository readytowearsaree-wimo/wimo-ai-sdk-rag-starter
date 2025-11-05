// app/api/ingest/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ---- Replace these with your real functions ---- **/
async function ingestOne(doc: { url: string; title?: string | null; text: string }) {
  // TODO: Split text -> create embeddings -> upsert into `documents` and `document_chunks`.
  // doc.url is required, doc.title is optional, doc.text is full content
  // Return whatever you want; here we just echo.
  return { ok: true, url: doc.url, length: doc.text.length };
}
/** ------------------------------------------------ **/

function authOk(req: NextRequest) {
  const expected = process.env.INGEST_SECRET?.trim();
  if (!expected) return true; // if you didn't set a secret, let it through
  const h1 = req.headers.get("x-ingest-secret")?.trim();
  const h2 = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return h1 === expected || h2 === expected;
}

async function parseMultipart(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return null;
  const text = await file.text();
  const url = (form.get("url") as string | null) ?? `faq://upload-${Date.now()}`;
  const title = (form.get("title") as string | null) ?? null;
  return [{ url, title, text }];
}

async function parseJSON(req: NextRequest) {
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return null;
  }

  // Shape A: { url, text }
  if (payload && typeof payload.url === "string" && typeof payload.text === "string") {
    return [{ url: payload.url, title: payload.title ?? null, text: payload.text }];
  }

  // Shape B: { documents: [ { title, url, content } ] }
  if (payload && Array.isArray(payload.documents)) {
    const out: Array<{ url: string; title?: string | null; text: string }> = [];
    for (const d of payload.documents) {
      if (d && typeof d.url === "string" && typeof d.content === "string") {
        out.push({ url: d.url, title: d.title ?? null, text: d.content });
      }
    }
    return out.length ? out : null;
  }

  return null;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const ctype = req.headers.get("content-type") || "";

  let docs:
    | Array<{ url: string; title?: string | null; text: string }>
    | null = null;

  if (ctype.startsWith("multipart/form-data")) {
    docs = await parseMultipart(req);
  } else if (ctype.includes("application/json")) {
    docs = await parseJSON(req);
  } else {
    // Some clients send no Content-Type; try JSON then multipart as a fallback
    docs = (await parseJSON(req)) ?? (await parseMultipart(req));
  }

  if (!docs || !docs.length) {
    return Response.json(
      {
        ok: false,
        error:
          "Invalid payload. Send either {url, text}, or {documents:[{title?, url, content}]}, or multipart with file (and optional url).",
      },
      { status: 400 }
    );
  }

  const results = [];
  for (const d of docs) {
    if (!d.url || !d.text) {
      results.push({ ok: false, url: d.url ?? null, error: "Missing url or text" });
      continue;
    }
    // Normalize Windows newlines just in case
    d.text = d.text.replace(/\r\n/g, "\n");
    results.push(await ingestOne(d));
  }

  return Response.json({ ok: true, count: results.length, results });
}
