// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ========= 環境変数 =========
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

// ========= 認証（任意） =========
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true;
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// ========= OpenAI呼び出しヘルパ =========
async function callOpenAIChatRaw(payload) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = j?.error?.message || `OpenAI HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j;
}

async function callOpenAIMap(items, style) {
  // items: [{id, text}] を 1 回のプロンプトで「id→書き換えテキスト」の JSON にしてもらう
  // 各テキストは長すぎると落ちやすいのでトリム
  const TRIM = 500;
  const safe = items.map(x => ({
    id: String(x.id),
    text: String(x.text || "").slice(0, TRIM)
  }));

  const listForPrompt = safe.map(x => `${x.id}\t${x.text.replace(/\n/g, " ")}`).join("\n");

  const messages = [
    {
      role: "system",
      content:
        "You are a Japanese rewriter. Rewrite each line's text to the requested style while keeping the original meaning and making it concise. Return ONLY pure JSON: " +
        '{"results":{"<id>":"<rewritten text>", ...}} . No extra text.'
    },
    {
      role: "user",
      content:
        `Style: ${style}\n` +
        "Input as TSV per line: <id>\\t<text>\n" +
        "Respond ONLY JSON mapping. Here are lines:\n" +
        listForPrompt
    }
  ];

  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.3,
    max_tokens: 1500,
    messages
  };

  const j = await callOpenAIChatRaw(payload);

  // 期待フォーマット：choices[0].message.content が JSON
  const content = j?.choices?.[0]?.message?.content || "";
  try {
    const parsed = JSON.parse(content);
    const map = parsed?.results || {};
    // 欠け分は原文で補完
    const out = {};
    for (const it of safe) {
      out[it.id] = typeof map[it.id] === "string" && map[it.id].trim()
        ? map[it.id].trim()
        : it.text; // 失敗時は原文
    }
    return out;
  } catch (e) {
    // JSON崩れ時：全件原文
    const out = {};
    for (const it of safe) out[it.id] = it.text;
    return out;
  }
}

// ========= ヘルス系 =========
app.get("/", (_req, res) => res.send("AI proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));
app.get("/health/openai", async (_req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.json({ ok: false, key: false });
    // 軽めのダミー
    await callOpenAIChatRaw({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 4,
      messages: [{ role: "user", content: "pong" }]
    });
    res.json({ ok: true, key: true });
  } catch (e) {
    res.json({ ok: false, key: true, error: String(e.message || e) });
  }
});

// ========= 簡易分析（ローカルルール） =========
// 返り値: { results: { [id]: { suggest: "keep"|"hide"|"rewrite" } } }
app.post("/analyze", (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const like = new Set(req.body?.like_tokens || []);
    const dislike = new Set(req.body?.dislike_tokens || []);
    const level = String(req.body?.level || "moderate");

    // levelで厳しさ変更（単純化）
    const NEG_PATTERNS_BASE = [
      /死ね|殺す|最悪|糞|クソ|バカ|馬鹿|黙れ|うざい|キモい|ぶっ殺/i,
      /fuck|shit|bitch|idiot|stupid/i
    ];
    const NEG_STRICT_ADD = [/は？|草|だるい|沼って|あああああ+|発狂/i];
    const NEG_PATTERNS = level === "strict"
      ? NEG_PATTERNS_BASE.concat(NEG_STRICT_ADD)
      : NEG_PATTERNS_BASE;

    const out = {};
    for (const it of items) {
      const t = String(it?.text || "");
      let suggest = "keep";
      // dislike語があれば優先で hide
      for (const w of dislike) {
        if (w && t.toLowerCase().includes(String(w).toLowerCase())) { suggest = "hide"; break; }
      }
      // ネガワードでも hide
      if (suggest === "keep") {
        if (NEG_PATTERNS.some(p => p.test(t))) suggest = "hide";
      }
      // like 語があれば rewrite 寄り
      if (suggest === "keep") {
        for (const w of like) {
          if (w && t.toLowerCase().includes(String(w).toLowerCase())) { suggest = "rewrite"; break; }
        }
      }
      out[it.id] = { suggest };
    }
    res.json({ results: out });
  } catch (e) {
    // ここも 500 にしない
    res.json({ results: {} , error: String(e.message || e) });
  }
});

// ========= 書き換え（AJ/校閲 共通） =========
// 入力: { style, items:[{id,text}...] }
// 出力: { results: { id: "書き換え後" } } ※常に 200
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const style = String(req.body?.style || "american_joke: witty, short; keep meaning; light gag").slice(0, 200);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.json({ results: {} });

    if (!OPENAI_API_KEY) {
      // キー未設定なら原文返す（エラーにしない）
      const back = {};
      for (const it of items) back[String(it.id)] = String(it.text || "");
      return res.json({ results: back, fallback: true });
    }

    const map = await callOpenAIMap(items, style);
    res.json({ results: map });
  } catch (e) {
    // 失敗時も 200 で返す（部分成功/フォールバック）
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const back = {};
      for (const it of items) back[String(it.id)] = String(it.text || "");
      res.json({ results: back, error: String(e.message || e) });
    } catch {
      res.json({ results: {}, error: String(e.message || e) });
    }
  }
});

// ========= 単発校閲 =========
// 入力: { text, style? }  出力: { text }
app.post("/polish", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const text = String(req.body?.text || "");
    const style = String(req.body?.style || "polish: de-escalate, remove profanity, keep meaning, natural concise Japanese");
    if (!OPENAI_API_KEY) return res.json({ text }); // キー無しは原文
    const map = await callOpenAIMap([{ id: "post", text }], style);
    res.json({ text: map["post"] || text });
  } catch (e) {
    res.json({ text: String(req.body?.text || ""), error: String(e.message || e) });
  }
});

// ========= 起動 =========
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ server up on :${PORT}`));
