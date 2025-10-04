// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ==== 環境変数 ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Set OPENAI_API_KEY in environment (Railway Secrets).");
  process.exit(1);
}

// 共有シークレット（任意）を使いたい場合
const SHARED_SECRET = process.env.SHARED_SECRET || "";

// ==== 共通関数 ====
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true; // シークレット未設定なら認証スキップ
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

async function callOpenAIChat({ model, messages, response_format }) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.6,
      max_tokens: 1500,
      ...(response_format ? { response_format } : {}),
    }),
  });

  const j = await r.json();
  if (!r.ok) {
    const msg = j?.error?.message || `OpenAI HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j?.choices?.[0]?.message?.content || "";
}

// ==== ヘルスチェック ====
app.get("/", (_req, res) => res.send("✅ AI proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// ==== Chat エンドポイント ====
app.post("/chat", async (req, res) => {
  if (!requireAuth(req, res)) return;

  try {
    const { messages, model = "gpt-4o-mini" } = req.body;
    if (!messages) {
      return res.status(400).json({ error: "messages is required" });
    }

    const result = await callOpenAIChat({ model, messages });
    res.json({ reply: result });
  } catch (e) {
    console.error("❌ /chat error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ==== サーバ起動 ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
