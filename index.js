// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ==== 環境変数 ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

// ==== 認証（任意） ====
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true; // 未設定ならスキップ
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// ==== OpenAI 呼び出し（任意） ====
async function callOpenAIChat({ model = "gpt-4o-mini", messages }) {
  if (!OPENAI_API_KEY) {
    // 未設定のときはここは使わず、下のローカル変換にフォールバック
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
      temperature: 0.4,
      max_tokens: 800,
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = j?.error?.message || `OpenAI HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j?.choices?.[0]?.message?.content || "";
}

/* =========================
   ローカル変換（フォールバック）
   ========================= */
const PROFANITY = [
  /死ね/g, /殺す/g, /バカ/g, /ばか/g, /馬鹿/g, /アホ/g, /くそ/g, /クソ/g,
  /ぶっ殺/g, /きもい/g, /カス/g, /黙れ/g, /最悪/g, /ゴミ/g, /うざ/g
];
function softenJapanese(text) {
  let t = String(text || "");

  // 絵文字/連続記号の減衰
  t = t.replace(/([!！?？。]){2,}/g, "$1");
  t = t.replace(/([wW]){3,}/g, "w");
  t = t.replace(/[\u{1F300}-\u{1FAFF}]{3,}/gu, "🙂");

  // 罵倒語を穏やかに
  t = t.replace(/死ね/g, "やめてほしいです")
       .replace(/殺す/g, "本当に困ります")
       .replace(/(バカ|ばか|馬鹿)/g, "よくないと思います")
       .replace(/アホ/g, "配慮に欠けています")
       .replace(/(くそ|クソ)/g, "良くありません")
       .replace(/ぶっ殺/g, "強い言葉を使ってしまいそう")
       .replace(/きもい/g, "苦手です")
       .replace(/カス/g, "残念です")
       .replace(/黙れ/g, "少し落ち着きたいです")
       .replace(/最悪/g, "あまり良くないです")
       .replace(/ゴミ/g, "満足できません")
       .replace(/うざ/g, "少し困っています");

  // 断定をやわらげる（軽め）
  t = t.replace(/だよね$/g, "だよね。")
       .replace(/だよ$/g, "だと思います。")
       .replace(/だ$/g, "だと思います。");

  // 語尾を丁寧に（乱暴な文っぽいときだけ）
  if (/^[^。！？\n]{2,}$/.test(t)) t += "。";
  t = t.replace(/！/g, "。").replace(/!+/g, "。");

  return t;
}

function toAmericanJokeLine(jp) {
  const base = softenJapanese(jp);
  // すでに十分短い時は軽く一行ボケ
  const addOns = [
    "…てことで、今日の私には追い風をください。",
    "— でもコーヒーは美味しかったのでチャラです。",
    "（教訓：寝不足に正義なし）",
    "…冗談です。半分だけ本気です。"
  ];
  const tail = addOns[Math.floor(Math.random() * addOns.length)];
  return `${base} ${tail}`;
}

/* ============ ルート類 ============ */
app.get("/", (_req, res) => res.send("AI proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// 簡易判定API：{results:{id:{suggest:"keep|hide|rewrite"}}}
app.post("/analyze", (req, res) => {
  if (!requireAuth(req, res)) return;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const like = new Set(req.body?.like_tokens || []);
  const dislike = new Set(req.body?.dislike_tokens || []);
  const out = {};
  for (const it of items) {
    const t = (it?.text || "").toLowerCase();
    let suggest = "keep";
    for (const w of dislike) if (w && t.includes(String(w).toLowerCase())) { suggest = "hide"; break; }
    if (suggest === "keep") {
      for (const w of like) if (w && t.includes(String(w).toLowerCase())) { suggest = "rewrite"; break; }
    }
    out[it.id] = { suggest };
  }
  res.json({ results: out });
});

// 書き換えAPI：{results:{id:"書き換え後"}}
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const style  = String(req.body?.style || "polite_clean").slice(0, 200);
    const items  = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = {};

    for (const it of items) {
      const original = String(it?.text ?? "");
      let rewritten = "";

      if (OPENAI_API_KEY) {
        // OpenAI あり：高品質変換
        const sys = style.includes("american_joke")
          ? "You rewrite Japanese into a short witty line with a light American-style joke. Keep meaning, no extra explanations. Output Japanese only."
          : "You rewrite Japanese into polite, calm, natural Japanese while keeping the meaning. Soften insults and harsh words. Output Japanese only.";
        const prompt = [
          { role: "system", content: sys },
          { role: "user",   content: original }
        ];
        rewritten = await callOpenAIChat({ messages: prompt });
      } else {
        // OpenAI なし：ローカル変換で必ず変える
        rewritten = style.includes("american_joke")
          ? toAmericanJokeLine(original)
          : softenJapanese(original);
      }

      // 念のため空なら原文
      out[it.id] = (rewritten && rewritten.trim()) ? rewritten.trim() : original;
    }
    res.json({ results: out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// おまけ：Chat そのまま（必要なら）
app.post("/chat", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { messages, model = "gpt-4o-mini" } = req.body;
    if (!messages) return res.status(400).json({ error: "messages is required" });
    const result = await callOpenAIChat({ model, messages });
    res.json({ reply: result });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ==== 起動 ====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ server up on :${PORT}`));
