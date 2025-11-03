// app/api/search/route.ts
import OpenAI from "openai";
import pkg from "pg";
import { NextResponse } from 'next/server';
import { textMatchScore } from '@/lib/utils'; // assuming you already have this utility

const { Client } = pkg;

const FAQ_MIN_SIM = 0.55;
const MAX_FAQ_RETURN = 3;
const REVIEW_GOOGLE_URL =
  "https://www.google.com/search?q=wimo+ready+to+wear+saree+reviews";

const ORDER_KEYWORDS = [
  "order","delivery","when will i get","where is my order","track my order",
  "status","pickup","courier","delayed",
];

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function textMatchScore(text: string, query: string) {
  const qWords = normalize(query).split(" ").filter(Boolean);
  const t = normalize(text);
  let score = 0; for (const w of qWords) if (t.includes(w)) score += 1;
  return score;
}
function parseReviewText(raw: string) {
  const out: { reviewer?: string; rating?: number|null; date?: string|null; review?: string; } = {};
  if (!raw) return out;

  // normalize whitespace
  const txt = raw.replace(/\r/g, "");

  // 1) reviewer → handles: "Reviewer: {'displayName': 'Prajna Kirtane'}", "displayName: '…'"
  const mName =
    /displayName['"]?\s*[:=]\s*['"]([^'"]+)['"]/i.exec(txt) ||
    /reviewer\s*:\s*['"]?([A-Za-z][^'"\n]+?)['"]?(?:\n|$)/i.exec(txt);
  if (mName) out.reviewer = mName[1].trim();

  // 2) rating → handles "Rating: 5", "rating 4.8", "⭐ 4.5/5"
  const mRating =
    /rating\s*[:\-]?\s*(\d+(?:\.\d+)?)/i.exec(txt) ||
    /([4-5](?:\.\d+)?)\s*\/\s*5/.exec(txt);
  out.rating = mRating ? Number(mRating[1]) : null;

  // 3) date → prefer ISO-like first
  const mIso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(txt);
  const mDateLine = mIso || /date\s*[:\-]?\s*([^\n]+)\n?/i.exec(txt);
  out.date = mDateLine ? mDateLine[1].trim() : null;

  // 4) review body
  const mReview =
    /^(?:review|comment)\s*:\s*([\s\S]+)$/im.exec(txt) ||
    /(?:^|[\n])\s*[-–•]\s*([\s\S]+)$/m.exec(txt);
  out.review = (mReview ? mReview[1] : txt).trim();

  return out;
}function json(obj:any, status=200){
  return new Response(JSON.stringify(obj),{
    status,
    headers:{
      "Access-Control-Allow-Origin":"*",
      "Content-Type":"application/json",
    }
  });
}

// CORS
export async function OPTIONS(){ return new Response(null,{status:204,headers:{
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Methods":"GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type, Authorization",
}}); }
export async function GET(){ return json({ok:true,msg:"search route is alive"},200); }

export async function POST(req) {
  try {
    const { query } = await req.json();

    // --- fetch data from sources ---
    const faqResults = await searchFromFAQ(query);
    const googleReviewsRaw = await searchFromGoogleReviews(); // your review fetch logic

    // --- parse Google reviews ---
    const parsedReviews = googleReviewsRaw?.results || [];

    // ✅ format and filter reviews
    const starText = (n) =>
      typeof n === "number" ? ` ${"⭐".repeat(Math.round(n))} (${n}/5)` : "";

    const relatedReviews = parsedReviews
      .map((rv, i) => ({
        ...rv,
        __score:
          textMatchScore(rv.text, query) + Math.max(0, 5 - i) * 0.2, // combine match + recency
      }))
      .filter((rv) => rv.__score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 3)
      .map((rv) => ({
        reviewer: rv.reviewer || null,
        rating: rv.rating ?? null,
        date: rv.date || null,
        text: rv.text,
      }));

    // --- prepare final response ---
    const responseObj = {
      ok: true,
      query,
      source: faqResults?.length ? 'faq' : relatedReviews?.length ? 'google-review' : 'none',
      results: faqResults.length ? faqResults : relatedReviews,
      message: faqResults.length
        ? null
        : relatedReviews.length
        ? null
        : "I couldn’t find this in FAQs or reviews.",
    };

    // --- send with CORS header ---
    return NextResponse.json(responseObj, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });

  } catch (error) {
    console.error("Error:", error);
    return NextResponse.json(
      { ok: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}}