// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ===== 環境変数 =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Set OPENAI_API_KEY in environment (Railway Secrets).");
  process.exit(1);
}
// 任意: 共有シークレット。クライアントはヘッダ x-proxy-secret を付ける
const SHARED_SECRET = process.env.SHARED_SECRET || "";

// ===== 共通ヘルパ =====
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true; // シークレット未設定時は認証スキップ
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
      temperature: 0.2,
      max_tokens: 1400,
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

// ===== ヘルスチェック / Wake =====
app.get("/", (_req, res) => res.send("✅ AI proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// OpenAI へ軽い問い合わせを行い、疎通だけ確認
app.get("/wake", async (_req, res) => {
  try {
    const messages = [
      { role: "system", content: "You are a ping helper." },
      { role: "user", content: "reply with OK" },
    ];
    const out = await callOpenAIChat({ model: "gpt-4o-mini", messages });
    res.json({ ok: true, reply: String(out).slice(0, 80) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== /chat （任意の会話プロキシ）=====
app.post("/chat", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { messages, model = "gpt-4o-mini", response_format } = req.body || {};
    if (!messages) return res.status(400).json({ error: "messages is required" });
    const reply = await callOpenAIChat({ model, messages, response_format });
    res.json({ reply });
  } catch (e) {
    console.error("❌ /chat error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ===== /analyze =====
// 期待する入力: { level, like_tokens[], dislike_tokens[], items:[{id,text}, ...] }
// 返却: { results: { "<id>": { suggest: "keep"|"hide"|"rewrite" } } }
app.post("/analyze", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const {
      level = "moderate",
      like_tokens = [],
      dislike_tokens = [],
      items,
    } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array required" });
    }

    const sys = [
      "You are a content triage assistant.",
      "Return strict JSON object mapping id -> {suggest}.",
      "suggest must be one of: keep, hide, rewrite.",
      "Use hide if the text likely violates common social norms, is toxic, harassing, sexual/minors, or matches user's dislike patterns.",
      "Use rewrite for borderline negative/harsh content that could be softened while keeping meaning.",
      "Otherwise use keep.",
    ].join(" ");

    const user = {
      level,
      like_tokens,
      dislike_tokens,
      items,
      // ユーザー語彙を軽くヒントに
      instruction:
        "Consider dislike_tokens as strong negatives. like_tokens are positive hints. Do not invent ids.",
    };

    const messages = [
      { role: "system", content: sys },
      {
        role: "user",
        content:
          "Input JSON:\n" +
          JSON.stringify(user) +
          "\nReturn JSON in the shape { \"results\": { \"<id>\": { \"suggest\": \"keep|hide|rewrite\" } } } and nothing else.",
      },
    ];

    const content = await callOpenAIChat({
      model: "gpt-4o-mini",
      messages,
      response_format: { type: "json_object" },
    });

    // content は JSON 文字列のはず
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { results: {} };
    }
    if (!parsed || typeof parsed !== "object" || !parsed.results) {
      parsed = { results: {} };
    }
    res.json(parsed);
  } catch (e) {
    console.error("❌ /analyze error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ===== /rewrite =====
// 期待する入力: { style, items:[{id,text}] }
// 返却: { results: { "<id>": "書き換え後テキスト" } }
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { style = "american_joke: witty, short; keep meaning; light gag", items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array required" });
    }

    const sys =
      "You rewrite short social posts. Keep the original meaning, reduce toxicity, and if requested, add a light witty twist. Output JSON only.";

    const user = {
      style,
      items,
      instruction:
        "Return JSON shape { \"results\": { \"<id>\": \"rewritten text\" } } with the same ids.",
    };

    const messages = [
      { role: "system", content: sys },
      {
        role: "user",
        content:
          "Input JSON:\n" +
          JSON.stringify(user) +
          "\nReturn JSON exactly in the shape { \"results\": { \"<id>\": \"rewritten\" } }.",
      },
    ];

    const content = await callOpenAIChat({
      model: "gpt-4o-mini",
      messages,
      response_format: { type: "json_object" },
    });

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { results: {} };
    }
    if (!parsed || typeof parsed !== "object" || !parsed.results) {
      parsed = { results: {} };
    }
    res.json(parsed);
  } catch (e) {
    console.error("❌ /rewrite error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ===== 起動 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
