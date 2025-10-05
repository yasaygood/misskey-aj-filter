// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ==== 環境変数 ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SHARED_SECRET  = process.env.SHARED_SECRET || "";

// ==== シークレット認証 ====
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true;
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// ==== OpenAI 呼び出し ====
async function callOpenAIChat({ model = "gpt-4o-mini", messages }) {
  if (!OPENAI_API_KEY) {
    const last = messages[messages.length - 1]?.content || "";
    return String(last);
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.5,
      max_tokens: 1000,
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = j?.error?.message || `OpenAI HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j?.choices?.[0]?.message?.content?.trim() || "";
}

// ==== health ====
app.get("/", (_req, res) => res.send("✅ AI proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// ==== analyze（AIフィルタ）====
app.post("/analyze", (req, res) => {
  if (!requireAuth(req, res)) return;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const like = new Set(req.body?.like_tokens || []);
  const dislike = new Set(req.body?.dislike_tokens || []);
  const out = {};
  for (const it of items) {
    const t = (it?.text || "").toLowerCase();
    let suggest = "keep";
    for (const w of dislike)
      if (t.includes(String(w).toLowerCase())) { suggest = "hide"; break; }
    if (suggest === "keep") {
      for (const w of like)
        if (t.includes(String(w).toLowerCase())) { suggest = "rewrite"; break; }
    }
    out[it.id] = { suggest };
  }
  res.json({ results: out });
});

// ==== rewrite（AJ変換＆AI校閲）====
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const style = String(req.body?.style || "polish").slice(0, 200);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = {};

    for (const it of items) {
      const original = String(it?.text || "");
      let rewritten = original;

      if (OPENAI_API_KEY) {
        const prompt = [
          {
            role: "system",
            content:
              "あなたは日本語の文章校閲アシスタントです。口汚い表現や攻撃的な言葉を、意味を変えずに自然で丁寧な言葉に直してください。短く、読みやすく、前向きな文体にしてください。",
          },
          { role: "user", content: original },
        ];
        rewritten = await callOpenAIChat({ messages: prompt });
      }

      out[it.id] = rewritten;
    }

    res.json({ results: out });
  } catch (e) {
    console.error("❌ /rewrite error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ==== 起動 ====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ server up on :${PORT}`));
