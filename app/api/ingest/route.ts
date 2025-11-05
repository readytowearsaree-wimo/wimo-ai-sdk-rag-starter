// app/api/ingest/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Replace with your real ingestion logic */
async function ingestOne(doc: { url: string; title?: string | null; text: string }) {
  return { ok: true, url: doc.url, length: doc.text.length };
}

/* ---------- AUTH HELPERS ---------- */

function getProvidedSecret(req: NextRequest) {
  const h1 = req.headers.get("x-ingest-secret") || "";
  const auth = req.headers.get("authorization") || "";
  const fromAuth = auth.replace(/^Bearer\s+/i, "");
  return (h1 || fromAuth).trim();
}

function secretsMatch(expected?: string | null, provided?: string | null) {
  expected = (expected ?? "").trim();
  provided = (provided ?? "").trim();
  if (!expected || !provided) return false;
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

/* ---------- PAYLOAD PARSERS ---------- */

async function parseMultipart(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return null;
  const text = await file.text();
  const url = (form.get("url") as string | null) ?? `faq-upload-${Date.now()}`;
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
  // Shape A: { url, text, title? }
  if (payload && typeof payload.url === "string" && typeof payload.text === "string") {
    return [{ url: payload.url, title: payload.title ?? null, text: payload.text }];
  }
  // Shape B: { documents: [{ title?, url, content }] }
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

/* ---------- HANDLER ---------- */

export async function POST(req: NextRequest) {
  const expected = process.env.INGEST_SECRET ?? "";
  const provided = getProvidedSecret(req);

  // TEMP debug (remove after it passes once)
  console.log("🔐 expected len:", expected.trim().length, "provided len:", provided.length);

  if (!secretsMatch(expected, provided)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const ctype = req.headers.get("content-type") || "";
  let docs: Array<{ url: string; title?: string | null; text: string }> | null = null;

  if (ctype.startsWith("multipart/form-data")) {
    docs = await parseMultipart(req);
  } else if (ctype.includes("application/json")) {
    docs = await parseJSON(req);
  } else {
    docs = (await parseJSON(req)) ?? (await parseMultipart(req));
  }

  if (!docs || !docs.length) {
    return Response.json(
      {
        ok: false,
        error:
          "Invalid payload. Send either {url, text, title?}, or {documents:[{title?, url, content}]}, or multipart with file (and optional url).",
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
    d.text = d.text.replace(/\r\n/g, "\n"); // normalize newlines
    results.push(await ingestOne(d));
  }

  return Response.json({ ok: true, count: results.length, results });
}