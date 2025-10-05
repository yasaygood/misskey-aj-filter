// index.js
import express from "express";
import cors from "cors";

// Node 18+ なら fetch はグローバルにあります。node-fetch は不要。
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ==== 環境変数 ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""; // 空でも動く
const SHARED_SECRET  = process.env.SHARED_SECRET  || ""; // 任意

// ==== 認証（任意） ====
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true;
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// ==== ロガー（Railway ログで見やすく） ====
function log(...args){ console.log("[srv]", ...args); }
function warn(...args){ console.warn("[srv]", ...args); }

// ==== OpenAI 呼び出し（安全版） ====
// 失敗しても throw しないで { ok:false, text, error } を返す
async function safeOpenAIChat({ model = "gpt-4o-mini", messages = [], max_tokens = 800, temperature = 0 }) {
  if (!OPENAI_API_KEY) {
    const last = messages[messages.length - 1]?.content || "";
    return { ok: false, text: String(last), error: "NO_OPENAI_KEY" };
  }
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, max_tokens, temperature }),
    });
    const j = await r.json();
    if (!r.ok) {
      warn("OpenAI error", r.status, j?.error?.message);
      return { ok: false, text: messages[messages.length - 1]?.content || "", error: j?.error?.message || `HTTP ${r.status}` };
    }
    const text = j?.choices?.[0]?.message?.content || "";
    return { ok: true, text };
  } catch (e) {
    warn("OpenAI fetch failed", e?.message || e);
    return { ok: false, text: messages[messages.length - 1]?.content || "", error: String(e?.message || e) };
  }
}

// ==== 簡易きれい化（OpenAI 不可時のフォールバック） ====
function soften(text) {
  if (!text) return text;
  // 代表的な暴言をやわらげる（最低限の例）
  return String(text)
    .replace(/(死ね|ﾀﾋね)/g, "つらい")
    .replace(/(ばか|バカ|馬鹿|アホ|クズ|カス)/g, "よくない")
    .replace(/(ぶっ殺|殺す)/g, "怒ってる")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ==== ルート ====
app.get("/", (_req, res) => res.send("AI proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// ---- Chat（任意）----
app.post("/chat", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { model = "gpt-4o-mini", messages = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages required" });
    }
    const r = await safeOpenAIChat({ model, messages, temperature: 0 });
    // 失敗しても200で返す（UIを止めない）
    res.json({ reply: r.text, openai_ok: r.ok, error: r.ok ? undefined : r.error });
  } catch (e) {
    // ここには基本来ないが、来ても 200 で最低限返す
    warn("/chat fatal", e?.message || e);
    res.json({ reply: messages?.[messages.length - 1]?.content || "", openai_ok: false, error: String(e?.message || e) });
  }
});

// ---- Analyze：{results:{id:{suggest:"keep|hide|rewrite"}}} ----
app.post("/analyze", (req, res) => {
  if (!requireAuth(req, res)) return;

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const like   = new Set(req.body?.like_tokens || []);
  const dislike= new Set(req.body?.dislike_tokens || []);
  const level  = String(req.body?.level || "moderate"); // relaxed|moderate|strict

  const rx = {
    profanity: /(死ね|殺す|バカ|馬鹿|アホ|クズ|カス|消えろ|キモ|最悪|○ね|ぶっ殺|fuck|shit|bitch)/i,
    sexual   : /(セックス|sex|エロ|ちん|まん|乳|レイプ|エッチ)/i,
    spamNoise: /([ぁ-んァ-ンｦ-ﾟa-zA-Z0-9])\1{6,}|[ぁあー]{6,}/i,
    emptyRp  : /^(\s*@\S+\s*|[#＃]\S+\s*|https?:\/\/\S+\s*)+$/i
  };

  const likeWords = [...like].map(s=>String(s).toLowerCase()).filter(Boolean);
  const dislikeWords = [...dislike].map(s=>String(s).toLowerCase()).filter(Boolean);

  function decide(text) {
    const t = String(text || "");
    const low = t.toLowerCase();

    for (const w of dislikeWords) if (w && low.includes(w)) return "hide";

    const hitProf = rx.profanity.test(t) || rx.sexual.test(t);
    const hitSpam = rx.spamNoise.test(t);
    const hitEmpty= rx.emptyRp.test(t);

    if (level === "strict") {
      if (hitProf || hitSpam || hitEmpty) return "hide";
    } else if (level === "moderate") {
      if (hitProf || hitEmpty) return "hide";
      if (hitSpam) return "rewrite";
    } else {
      if (hitProf) return "hide";
      if (hitSpam || hitEmpty) return "rewrite";
    }

    for (const w of likeWords) if (w && low.includes(w)) return "rewrite";
    return "keep";
  }

  const out = {};
  for (const it of items) out[it.id] = { suggest: decide(it?.text) };
  res.json({ results: out });
});

// ---- Rewrite：{results:{id:"書き換え後"}}（AJ/クリーン化）----
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const style = String(req.body?.style || "american_joke").slice(0, 200);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = {};

    for (const it of items) {
      const original = String(it?.text || "");
      let rewritten = original;

      // OpenAI へ挑戦 → ダメでもフォールバックして続行
      const system =
        style.indexOf("american_joke") >= 0
          ? "日本語の投稿を短いアメリカンジョーク調に。攻撃性を和らげ、意味は保ち、最後に軽い落ち。日本語のみ。"
          : `日本語の投稿を「${style}」の雰囲気に。攻撃性を和らげ、意味は保つ。日本語のみ。`;

      const r = await safeOpenAIChat({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: original }
        ],
        temperature: 0.2,
        max_tokens: 400
      });

      if (r.ok && r.text && r.text.trim()) {
        rewritten = r.text.trim();
      } else {
        // フォールバック（簡易きれい化 or そのまま）
        rewritten = style.indexOf("american_joke") >= 0
          ? soften(original) + "（※軽変換）"
          : soften(original);
      }
      out[it.id] = rewritten;
    }
    // ここまで来たら必ず 200
    res.json({ results: out });
  } catch (e) {
    // 何があっても 200 で原文返す（UIを止めない）
    warn("/rewrite fatal", e?.message || e);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const out = {};
    for (const it of items) out[it.id] = String(it?.text || "");
    res.json({ results: out, degraded: true, error: String(e?.message || e) });
  }
});

// ==== 起動 ====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => log(`✅ server up on :${PORT}`));
