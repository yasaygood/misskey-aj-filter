// index.js — 方言＋英語対応サーバ（OpenAI 経由 /rewrite /filter）

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

/* ===== 環境変数 ===== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

/* ===== 認証 ===== */
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true;
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

/* ===== OpenAI呼び出し ===== */
async function callOpenAIChat({ model = "gpt-4o-mini", messages, temperature = 0.7, max_tokens = 1000 }) {
  if (!OPENAI_API_KEY) {
    const last = messages[messages.length - 1]?.content || "";
    return last;
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return j?.choices?.[0]?.message?.content || "";
}

/* ===== 方言定義 ===== */
const DIALECTS = {
  beranmee:  "江戸っ子べらんめえ口調。陽気で荒っぽい。",
  kansai:    "関西弁。柔らかくフレンドリー。",
  hakata:    "博多弁。やさしく親しみやすい。",
  tohoku:    "東北なまり。素朴で温かい。",
  nagoya:    "名古屋弁。明るく軽い。",
  okinawa:   "沖縄訛り。柔らかく陽気。",
  random:    "方言をランダムに選択。",
  english:   "自然な標準英語（US）。",
  british:   "ブリティッシュ英語。",
  american:  "アメリカ英語。",
  australian:"オーストラリア英語。",
  english_jp:"日本語混じりの和製英語スタイル。"
};

/* ===== プロンプト生成 ===== */
function buildMessages(text, dialect, strength = 1.2) {
  const baseSys =
    `あなたは方言変換アシスタントです。攻撃的・下品・暴力的な表現は禁止。` +
    `リンク・@・# は改変しないでください。強度:${strength}`;

  // 英語モードは出力言語明示
  if (dialect.startsWith("english") || ["british","american","australian","english_jp"].includes(dialect)) {
    return [
      { role: "system", content: `${baseSys}。入力日本語を ${DIALECTS[dialect]} に翻訳。自然な会話調の英語で。` },
      { role: "user", content: text }
    ];
  }

  // 日本語方言
  return [
    { role: "system", content: `${baseSys}。入力文を ${DIALECTS[dialect] || "自然な口調"} に変換。` },
    { role: "user", content: text }
  ];
}

/* ===== Routes ===== */
app.get("/", (_, res) => res.send("方言AI proxy running"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ---- /rewrite ----
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const style = String(req.body?.style || "dialect:beranmee");
    const dialect = style.split(":")[1] || "beranmee";
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const strength = Number(req.body?.strength ?? 1.2);
    const result = {};
    for (const it of items) {
      const text = String(it?.text || "");
      const msgs = buildMessages(text, dialect, strength);
      const out = await callOpenAIChat({ messages: msgs, temperature: strength >= 1.3 ? 0.9 : 0.7 });
      result[it.id] = out.trim();
    }
    res.json({ results: result, meta: { dialect, strength, used: OPENAI_API_KEY ? "openai" : "none" } });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- /filter ----
app.post("/filter", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const text = String(req.body?.text || "");
    const dialect = String(req.body?.dialect || "beranmee");
    const strength = Number(req.body?.strength ?? 1.2);
    const msgs = buildMessages(text, dialect, strength);
    const out = await callOpenAIChat({ messages: msgs });
    res.json({ ok: true, text: out.trim(), meta: { dialect, strength } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---- /dialects ----
app.get("/dialects", (_, res) => res.json({ dialects: DIALECTS }));

/* ===== 起動 ===== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ 方言AIサーバ起動 port=${PORT}`));
