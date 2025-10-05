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
const SHARED_SECRET = process.env.SHARED_SECRET || ""; // 任意

// ==== 共通 ====
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true;
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

async function openAIChatJSON({ model, messages }) {
  // JSON を厳格に返させる
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages,
      max_tokens: 1800,
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = j?.error?.message || `OpenAI HTTP ${r.status}`;
    throw new Error(msg);
  }
  const content = j?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

async function openAIChatText({ model, messages }) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.6,
      messages,
      max_tokens: 1800,
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

// ==== 既存の chat ====
app.post("/chat", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { messages, model = "gpt-4o-mini" } = req.body;
    if (!messages) return res.status(400).json({ error: "messages is required" });
    const reply = await openAIChatText({ model, messages });
    res.json({ reply });
  } catch (e) {
    console.error("❌ /chat error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ==== analyze: テキスト群に keep/hide/rewrite を付与 ====
app.post("/analyze", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const {
      items = [],                   // [{ id, text }]
      like_tokens = [],             // ["かわいい", ...]
      dislike_tokens = [],          // ["グロ", ...]
      level = "moderate",           // relaxed | moderate | strict
      model = "gpt-4o-mini"
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ results: {} });
    }

    // まず軽いローカル判定（高速・省コスト）
    const fastMap = {};
    const dl = new Set(dislike_tokens.filter(Boolean).map(String));
    const ll = new Set(like_tokens.filter(Boolean).map(String));

    const hitToken = (text, bag) => {
      const t = (text || "").toLowerCase();
      for (const w of bag) {
        if (!w) continue;
        if (t.includes(String(w).toLowerCase())) return true;
      }
      return false;
    };

    for (const it of items) {
      const text = String(it.text || "");
      if (!text.trim()) { fastMap[it.id] = { suggest: "keep" }; continue; }
      if (hitToken(text, dl)) { fastMap[it.id] = { suggest: "hide", reason: "dislike_token" }; continue; }
      fastMap[it.id] = { suggest: "keep" };
    }

    // OpenAI できめ細かい最終判定（JSON で返させる）
    // 失敗したら fastMap を返すフェイルセーフ
    let finalMap = fastMap;
    try {
      const sys = {
        role: "system",
        content:
          "You are a safety/content triage. For each item, output JSON {results:{<id>:{suggest}}}. " +
          "suggest ∈ {keep, hide, rewrite}. " +
          "Consider tone/toxicity/NSFW. Level 'strict' → hide more, 'relaxed' → hide less. " +
          "Prefer 'hide' for spam/hate/NSFW/very offensive. Use 'rewrite' for mildly toxic or negative that can be softened. " +
          "Output JSON only."
      };
      const user = {
        role: "user",
        content: JSON.stringify({
          level,
          items,
          like_tokens,
          dislike_tokens
        })
      };
      const json = await openAIChatJSON({ model, messages: [sys, user] });
      if (json && json.results && typeof json.results === "object") {
        finalMap = json.results;
      }
    } catch (e) {
      console.warn("⚠️ /analyze: fallback to fastMap:", e.message);
    }

    res.json({ results: finalMap });
  } catch (e) {
    console.error("❌ /analyze error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ==== rewrite: テキスト群をスタイル指定でリライト ====
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const {
      items = [],                   // [{ id, text }]
      style = "american_joke: witty, playful, short; keep meaning; soften negativity; light gag",
      model = "gpt-4o-mini"
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ results: {} });
    }

    const sys = {
      role: "system",
      content:
        "Rewrite short social posts. Keep original meaning, make it concise. " +
        "Apply the given style. Output JSON {results:{<id>: <rewrittenText>}} only."
    };
    const user = {
      role: "user",
      content: JSON.stringify({ style, items })
    };

    let json;
    try {
      json = await openAIChatJSON({ model, messages: [sys, user] });
    } catch (e) {
      // JSONモード失敗時のフォールバック（テキスト→JSON化）
      const txt = await openAIChatText({ model, messages: [sys, user] });
      try { json = JSON.parse(txt); } catch { json = { results: {} }; }
    }

    const results = (json && json.results && typeof json.results === "object")
      ? json.results
      : {};

    // 念のため: 足りないidはパススルー
    for (const it of items) {
      if (typeof results[it.id] !== "string") {
        results[it.id] = it.text;
      }
    }

    res.json({ results });
  } catch (e) {
    console.error("❌ /rewrite error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ==== 起動 ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
