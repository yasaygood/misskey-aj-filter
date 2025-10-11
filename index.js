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

// ==== OpenAI 呼び出し ====
async function callOpenAIChat({ model = "gpt-4o-mini", messages, temperature = 0.4, max_tokens = 800 }) {
  if (!OPENAI_API_KEY) {
    // キー未設定：ここではエラーにせず、最後のユーザー発話をそのまま返す
    const last = messages[messages.length - 1]?.content || "";
    return String(last);
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens }),
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
   ※ べらんめえ等はサーバでは行わず、
      OpenAIキー未設定時は「原文そのまま」を返します。
   ========================= */
const PROFANITY = [
  /死ね/g, /殺す/g, /バカ/g, /ばか/g, /馬鹿/g, /アホ/g, /くそ/g, /クソ/g,
  /ぶっ殺/g, /きもい/g, /カス/g, /黙れ/g, /最悪/g, /ゴミ/g, /うざ/g
];
function softenJapanese(text) {
  let t = String(text || "");
  t = t.replace(/([!！?？。]){2,}/g, "$1");
  t = t.replace(/([wW]){3,}/g, "w");
  t = t.replace(/[\u{1F300}-\u{1FAFF}]{3,}/gu, "🙂");
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
  if (/^[^。！？\n]{2,}$/.test(t)) t += "。";
  t = t.replace(/！/g, "。").replace(/!+/g, "。");
  return t;
}

function toAmericanJokeLine(jp) {
  const base = softenJapanese(jp);
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

/* -------------- 方言プリセット -------------- */
const DIALECTS = {
  beranmee: "江戸っ子『べらんめえ』口調で、荒っぽく陽気に。語尾は〜だぜ/〜だな/〜しな等。暴言や誹謗中傷はしない。",
  kansai:   "関西弁で、柔らかめの会話調。〜やで/〜やん/〜してな等。きつ過ぎないトーン。",
  hakata:   "博多弁。親しみやすく柔らかい調子。",
  tohoku:   "東北訛りを感じるやさしい語り口。",
  nagoya:   "名古屋弁のニュアンスを軽く添える口調。",
  okinawa:  "沖縄方言の雰囲気を穏やかに織り交ぜる口調。",
  random:   "上記のいずれかを自然に選び、崩しすぎず読みやすく。"
};
const PLACEHOLDER_GUARD =
  "テキスト中のURL・@メンション・#ハッシュタグ・絵文字などのプレースホルダは削除/改変せず、位置もできるだけ保ってください。出力は日本語のみ。説明文は不要。";

/* -------------- /rewrite（方言対応＋メタ返却） --------------
 * 入力: { style: 'dialect:beranmee' | 'american_joke' | 'polite_clean'..., items:[{id,text},...] }
 * 出力: { results: { [id]: "変換後" }, meta: {route, used, dialect, styleRaw} }
 */
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const styleRaw = String(req.body?.style || "polite_clean");
    const items  = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = {};
    const meta = { route: "rewrite", used: "", dialect: null, styleRaw };

    const isDialect = styleRaw.startsWith("dialect:");
    const dialectKey = isDialect ? (styleRaw.split(":")[1] || "beranmee") : null;

    for (const it of items) {
      const original = String(it?.text ?? "");
      let rewritten = "";

      if (OPENAI_API_KEY) {
        meta.used = "openai";
        // OpenAIを使った高品質変換
        let system, user;
        if (isDialect) {
          const key = DIALECTS[dialectKey] ? dialectKey : "beranmee";
          const styleNote = DIALECTS[key];
          system = `あなたは日本語の文体変換アシスタントです。${PLACEHOLDER_GUARD}`;
          user   = `方言: ${key}\nスタイル指示: ${styleNote}\n---\n${original}`;
          meta.dialect = key;
        } else {
          const base =
            styleRaw.includes("american_joke")
              ? "日本語を短い軽口のウィットに富んだ一行に。意味は保ち、説明は書かない。"
              : "日本語をていねいで落ち着いた自然な文へ言い換える。意味は保つ。";
          system = `${base} ${PLACEHOLDER_GUARD}`;
          user   = original;
        }
        const messages = [
          { role: "system", content: system },
          { role: "user",   content: user },
        ];
        rewritten = await callOpenAIChat({ model: "gpt-4o-mini", messages });
      } else {
        meta.used = "none";  // キー未設定
        rewritten = original;
      }

      out[it.id] = (rewritten && rewritten.trim()) ? rewritten.trim() : original;
    }

    res.json({ results: out, meta });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* -------------- /filter（互換レイヤ＋メタ返却） --------------
 * 入力: { text: "..." , dialect?: "beranmee"|... }
 * 出力: { ok:true, text:"...", meta:{route,used,dialect} }
 */
app.post("/filter", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const text = String(req.body?.text || "");
    const dialect = String(req.body?.dialect || req.body?.mode || "beranmee");
    if (!text) return res.status(400).json({ ok: false, error: "no text" });

    let out = text;
    const meta = { route: "filter", used: "", dialect };

    if (OPENAI_API_KEY) {
      meta.used = "openai";
      const key = DIALECTS[dialect] ? dialect : "beranmee";
      const styleNote = DIALECTS[key];
      const messages = [
        { role: "system", content: `日本語の文体変換アシスタントです。${PLACEHOLDER_GUARD}` },
        { role: "user",   content: `方言: ${key}\nスタイル指示: ${styleNote}\n---\n${text}` }
      ];
      out = await callOpenAIChat({ model: "gpt-4o-mini", messages });
      out = (out && out.trim()) || text;
    } else {
      meta.used = "none";
    }
    return res.json({ ok: true, text: out, meta });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// おまけ：Chat そのまま
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
