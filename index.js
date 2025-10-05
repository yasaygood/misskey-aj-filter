// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

// ==== 環境変数 ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SHARED_SECRET = process.env.SHARED_SECRET || "";

// ==== 認証 ====
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true;
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// ==== OpenAI呼び出し ====
async function callOpenAIChat({ messages, model = "gpt-4o-mini" }) {
  if (!OPENAI_API_KEY) {
    const last = messages[messages.length - 1]?.content || "";
    return String(last);
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.5,
      max_tokens: 800,
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  return j?.choices?.[0]?.message?.content?.trim() || "";
}

// ==== ルート ====
app.get("/", (_req, res) => res.send("✅ AI proxy running"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// ==== /analyze（AIフィルタ）====
app.post("/analyze", (req, res) => {
  if (!requireAuth(req, res)) return;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const like = new Set(req.body?.like_tokens || []);
  const dislike = new Set(req.body?.dislike_tokens || []);
  const out = {};

  for (const it of items) {
    const text = (it?.text || "").toLowerCase();
    let suggest = "keep";
    for (const w of dislike) if (text.includes(w.toLowerCase())) { suggest = "hide"; break; }
    if (suggest === "keep") {
      for (const w of like) if (text.includes(w.toLowerCase())) { suggest = "rewrite"; break; }
    }
    out[it.id] = { suggest };
  }

  res.json({ results: out });
});

// ==== /rewrite（AJ・AI校閲）====
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const style = String(req.body?.style || "polite").slice(0, 200);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = {};

    // まとめて処理
    await Promise.all(
      items.map(async (it) => {
        const original = String(it?.text || "");
        let prompt = [
          { role: "system", content: `あなたは日本語の文章を校閲・改善します。style=${style}。\n攻撃的・下品・怒り口調の文章を自然で丁寧な表現に書き換えてください。意味は変えないこと。` },
          { role: "user", content: original }
        ];
        const rewritten = await callOpenAIChat({ messages: prompt });
        out[it.id] = rewritten || original;
      })
    );

    res.json({ results: out });
  } catch (e) {
    res.status(500).json({ error: e.message || e });
  }
});

// ==== 起動 ====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server up on :${PORT}`));
