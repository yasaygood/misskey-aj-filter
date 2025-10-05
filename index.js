// index.js — Misskey AIフィルター + 好き嫌い学習 + AI校閲 + AJ変換対応 安定版
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

// ==== OpenAI呼び出し ====
async function callOpenAIChat({ model, messages }) {
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
      model: model || "gpt-4o-mini",
      messages,
      temperature: 0.6,
      max_tokens: 1000,
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = j?.error?.message || `OpenAI HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j?.choices?.[0]?.message?.content || "";
}

// ==== ルート ====
app.get("/", (_req, res) => res.send("✅ AI proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// ==== 感情・学習分析API ====
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
      if (w && t.includes(String(w).toLowerCase())) { suggest = "hide"; break; }
    if (suggest === "keep") {
      for (const w of like)
        if (w && t.includes(String(w).toLowerCase())) { suggest = "rewrite"; break; }
    }
    out[it.id] = { suggest };
  }
  res.json({ results: out });
});

// ==== リライト(AJ/AI校閲) ====
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const style = String(req.body?.style || "polite_japanese").slice(0, 200);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = {};

    for (const it of items) {
      const original = String(it?.text || "");
      let rewritten = original;

      if (OPENAI_API_KEY) {
        const prompt = [
          { role: "system", content: `
あなたはSNS投稿の文章校正AIです。
ユーザーの文章を丁寧で自然な日本語に書き換えます。
攻撃的・暴言・不適切表現を穏やかでフレンドリーな表現に修正します。
必要であれば軽いユーモアを加えても構いません。
内容は変えずに、読みやすく優しい文章にしてください。
出力は日本語のリライト文のみ。` },
          { role: "user", content: original }
        ];
        rewritten = await callOpenAIChat({ model: "gpt-4o-mini", messages: prompt });
      }
      out[it.id] = rewritten;
    }
    res.json({ results: out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ==== 起動 ====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ server running on port ${PORT}`));
