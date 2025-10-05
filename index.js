// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ==== 環境変数 ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""; // 無くても動く（フォールバック）
const SHARED_SECRET  = process.env.SHARED_SECRET || "";  // 任意

// ==== 認証（任意） ====
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true; // 未設定ならスキップ
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// ==== OpenAI（任意）====
async function callOpenAIChat({ model, messages, response_format }) {
  if (!OPENAI_API_KEY) {
    // フォールバック：OpenAI未設定なら最後のユーザ発話をそのまま返す
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
      temperature: 0,          // 安定重視
      max_tokens: 800,
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

// ==== ルート ====
app.get("/", (_req, res) => res.send("AI proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// ---- Chat：任意の会話/リライト用（VMの投稿クリーン化で使用）----
app.post("/chat", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { model = "gpt-4o-mini", messages = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages required" });
    }
    const reply = await callOpenAIChat({ model, messages });
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Analyze：{results:{id:{suggest:"keep|hide|rewrite"}}} ----
app.post("/analyze", (req, res) => {
  if (!requireAuth(req, res)) return;

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const like   = new Set(req.body?.like_tokens || []);
  const dislike= new Set(req.body?.dislike_tokens || []);
  const level  = String(req.body?.level || "moderate"); // relaxed|moderate|strict

  // ざっくりルール（ローカルTL向けの安全寄り）
  const rx = {
    profanity: /(死ね|殺す|バカ|馬鹿|アホ|クズ|カス|消えろ|キモ|最悪|○ね|ぶっ殺|fuck|shit|bitch)/i,
    sexual   : /(セックス|sex|エロ|ちん|まん|乳|レイプ|エッチ)/i,
    spamNoise: /([ぁ-んァ-ンｦ-ﾟa-zA-Z0-9])\1{6,}|[ぁあー]{6,}/i, // 発狂・連呼
    emoji    : /[\u{1F600}-\u{1F6FF}\u{1F300}-\u{1FAFF}]/u,    // 参考：絵文字
    emptyRp  : /^(\s*@\S+\s*|[#＃]\S+\s*|https?:\/\/\S+\s*)+$/i // 空中リプ/タグ・URLだけ
  };

  const likeWords = [...like].map(s=>String(s).toLowerCase()).filter(Boolean);
  const dislikeWords = [...dislike].map(s=>String(s).toLowerCase()).filter(Boolean);

  function decide(text) {
    const t = String(text || "");
    const low = t.toLowerCase();

    // 学習優先
    for (const w of dislikeWords) if (w && low.includes(w)) return "hide";
    // レベル強いほど hide 範囲を広げる
    const hitProf = rx.profanity.test(t) || rx.sexual.test(t);
    const hitSpam = rx.spamNoise.test(t);
    const hitEmpty= rx.emptyRp.test(t);

    if (level === "strict") {
      if (hitProf || hitSpam || hitEmpty) return "hide";
    } else if (level === "moderate") {
      if (hitProf || hitEmpty) return "hide";
      if (hitSpam) return "rewrite";
    } else {
      // relaxed
      if (hitProf) return "hide";
      if (hitSpam || hitEmpty) return "rewrite";
    }

    // like は rewrite 推奨（軽くジョーク化等）
    for (const w of likeWords) if (w && low.includes(w)) return "rewrite";

    return "keep";
  }

  const out = {};
  for (const it of items) out[it.id] = { suggest: decide(it?.text) };
  res.json({ results: out });
});

// ---- Rewrite：{results:{id:"書き換え後"}}（AJなど）----
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const style = String(req.body?.style || "american_joke").slice(0, 200);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = {};

    for (const it of items) {
      const original = String(it?.text || "");
      let rewritten = original;

      if (OPENAI_API_KEY) {
        // スタイル別の system 指示
        const system =
          style.indexOf("american_joke") >= 0
            ? "日本語の投稿を短いアメリカンジョーク調に。攻撃性を和らげ、意味は保ち、最後に軽い落ち。日本語のみ。"
            : `日本語の投稿を「${style}」の雰囲気に。攻撃性を和らげ、意味は保つ。日本語のみ。`;

        const prompt = [
          { role: "system", content: system },
          { role: "user", content: original }
        ];
        rewritten = await callOpenAIChat({ messages: prompt });
      }
      out[it.id] = rewritten;
    }
    res.json({ results: out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ==== 起動 ====
const PORT = process.env.PORT || 8080; // Railway でもOK
app.listen(PORT, () => console.log(`✅ server up on :${PORT}`));
