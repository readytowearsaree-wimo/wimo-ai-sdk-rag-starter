// app/api/search/route.ts
import OpenAI from "openai";
import pkg from "pg";
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
  const out: any = { raw };
  if (!raw) return out;
  const lines = raw.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.toLowerCase().startsWith("reviewer:")) out.reviewer = line.split(":").slice(1).join(":").trim();
    else if (line.toLowerCase().startsWith("rating:")) {
      const n = Number(line.replace(/rating:/i,"").trim()); if (!Number.isNaN(n)) out.rating = n;
    } else if (line.toLowerCase().startsWith("date:")) out.date = line.replace(/date:/i,"").trim();
  }
  const rLine = lines.find(l => l.toLowerCase().startsWith("review:") || l.toLowerCase().startsWith("comment:"));
  out.review = rLine ? rLine.split(":").slice(1).join(":").trim() : raw.trim();
  return out;
}
function json(obj:any, status=200){
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

export async function POST(req: Request){
  try{
    const body = await req.json().catch(()=>({}));
    const query = (body?.query ?? "").toString().trim();
    const topK  = Math.min(Math.max(Number(body?.topK ?? 14),1),40);
    const askDebug = !!body?.debug;
    if(!query) return json({ok:false,error:"Missing 'query'"},400);

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_CONN  = process.env.SUPABASE_CONN;
    if(!OPENAI_API_KEY || !SUPABASE_CONN) return json({ok:false,error:"Missing OPENAI_API_KEY or SUPABASE_CONN"},500);

    // 1) Embed ONLY for FAQ vector search
    const openai = new OpenAI({apiKey:OPENAI_API_KEY});
    const emb = await openai.embeddings.create({ model:"text-embedding-3-small", input: query });
    const vecLiteral = `[${emb.data[0].embedding.join(",")}]`;

    const client = new Client({connectionString: SUPABASE_CONN});
    await client.connect();

    // 2a) FAQ by vectors (requires embedding)
    const sqlFaq = `
      select dc.document_id, d.url, d.meta, dc.chunk_index, dc.content,
             1 - (dc.embedding <=> $1::vector) as similarity
      from document_chunks dc
      join documents d on d.id = dc.document_id
      where dc.embedding is not null
      order by dc.embedding <=> $1::vector
      limit $2;
    `;
    const { rows: faqRows } = await client.query(sqlFaq, [vecLiteral, topK]);

    // 2b) Reviews WITHOUT vectors (works when embedding is NULL)
    // We rely on the *document* meta having source = 'google-review'
    const sqlReviews = `
      select dc.document_id, d.url, d.meta, dc.chunk_index, dc.content
      from document_chunks dc
      join documents d on d.id = dc.document_id
      where (d.meta->>'source') = 'google-review'
      order by dc.id desc
      limit 600;
    `;
    const { rows: reviewRowsRaw } = await client.query(sqlReviews, []);
    await client.end();

    // 3) shape
    const faqs = faqRows
      .filter((r:any) => (r.meta?.source ?? r.meta?.type ?? "faq") === "faq")
      .map((r:any)=>({ content:r.content, similarity:Number(r.similarity) }));

    // guarantee at least one FAQ if any exist
    let faqHits = faqs.filter((f:any)=>f.similarity >= FAQ_MIN_SIM).slice(0,MAX_FAQ_RETURN);
    if (faqHits.length===0 && faqs.length>0){
      const looksOrder = ORDER_KEYWORDS.some(kw => normalize(query).includes(kw));
      if (looksOrder){
        // crude rescue: pick the first FAQ that mentions any order keyword
        const orderLike = faqRows
          .filter((r:any)=> (r.meta?.source ?? "faq")==="faq")
          .map((r:any)=>({ ...r, score: ORDER_KEYWORDS.reduce((a,kw)=>a+(normalize(r.content).includes(kw)?1:0),0)}))
          .filter((r:any)=>r.score>0)
          .sort((a:any,b:any)=>b.score-a.score);
        if (orderLike.length>0) {
          faqHits = [{ content: orderLike[0].content, similarity: Number(orderLike[0].similarity) }];
        } else {
          faqHits = [{ content: faqs[0].content, similarity: faqs[0].similarity }];
        }
      } else {
        faqHits = [{ content: faqs[0].content, similarity: faqs[0].similarity }];
      }
    }

    // Reviews: parse & score lexically
    const parsedReviews = reviewRowsRaw.map((r:any)=>{
      const p = parseReviewText(r.content||"");
      return {
        reviewer: p.reviewer || null,
        rating:   p.rating ?? null,
        date:     p.date   || null,
        text:     p.review || r.content || "",
      };
    });

    const relatedReviews = parsedReviews
      .map((rv:any, idx:number)=> ({ ...rv, __score: textMatchScore(rv.text, query) + Math.max(0,5-idx)*0.2 }))
      .filter((rv:any)=> rv.__score > 0)
      .sort((a:any,b:any)=> b.__score - a.__score)
      .slice(0,3)
      .map(({reviewer,rating,date,text}:any)=>({reviewer,rating,date,text}));

    // Build response
    if (faqHits.length>0){
      return json({
        ok:true,
        query,
        source:"faq",
        results: faqHits,
        relatedReviews,
        reviewLink: REVIEW_GOOGLE_URL,
        ...(askDebug? {debug:{faqCount:faqs.length, reviewCount:parsedReviews.length}} : {}),
      });
    }

    if (relatedReviews.length>0){
      return json({
        ok:true,
        query,
        source:"google-review",
        results: relatedReviews,
        reviewLink: REVIEW_GOOGLE_URL
      });
    }

    return json({
      ok:true,
      query,
      source:"none",
      results: [],
      reviewLink: REVIEW_GOOGLE_URL,
      message:"I couldn’t find this in FAQs or reviews.",
    });

  }catch(err:any){
    console.error("Search error:", err);
    return json({ok:false,error:String(err?.message||err)},500);
  }
}