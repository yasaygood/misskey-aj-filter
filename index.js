// index.js — Stable AI proxy with persistent learning store (JSON file)
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { promises as fs } from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ===== Env =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";
const PORT           = process.env.PORT || 8080;
const LEARN_PATH     = process.env.LEARN_PATH || path.resolve("./learn.json");

// ===== Auth helper =====
function okAuth(req, res) {
  if (!SHARED_SECRET) return true;
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}
const toStr = (x)=> (x==null ? "" : String(x));
const take  = (arr,n)=> Array.isArray(arr) ? arr.slice(0,n) : [];

// ===== Persistent learning store =====
const Learn = {
  like:    new Set(),
  dislike: new Set(),
  _dirty:  false,
  async load() {
    try {
      const raw = await fs.readFile(LEARN_PATH, "utf8");
      const j = JSON.parse(raw);
      this.like    = new Set(Array.isArray(j.like_tokens)    ? j.like_tokens    : []);
      this.dislike = new Set(Array.isArray(j.dislike_tokens) ? j.dislike_tokens : []);
      this._dirty = false;
      // console.log("Loaded learn store:", this.like.size, this.dislike.size);
    } catch {
      // 初回はファイルが無くてもOK
      this.like = new Set(); this.dislike = new Set(); this._dirty = true;
      await this.save(); // 空で作る
    }
  },
  async save() {
    if (!this._dirty) return;
    const data = JSON.stringify({
      like_tokens:    [...this.like],
      dislike_tokens: [...this.dislike],
      saved_at: Date.now()
    });
    await fs.writeFile(LEARN_PATH, data, "utf8");
    this._dirty = false;
  },
  addLike(arr){ for (const w of (arr||[])) { const t=toStr(w).trim(); if (t) this.like.add(t); } this._dirty = true; },
  addDislike(arr){ for (const w of (arr||[])) { const t=toStr(w).trim(); if (t) this.dislike.add(t); } this._dirty = true; },
  export(){ return { like_tokens: [...this.like], dislike_tokens: [...this.dislike] }; },
  async reset(){ this.like.clear(); this.dislike.clear(); this._dirty = true; await this.save(); }
};

// 定期フラッシュ（書き込みをまとめる）
setInterval(()=>{ Learn.save().catch(()=>{}); }, 3000);

// 起動時ロード
await Learn.load().catch(()=>{});

// ===== OpenAI wrapper =====
async function callOpenAIChat({ model, messages, response_format }) {
  if (!OPENAI_API_KEY) {
    // OpenAI未設定ならフォールバック：最後のuser発話を返す
    const last = messages[messages.length - 1]?.content || "";
    return toStr(last);
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
      temperature: 0.4,
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

// ===== Health =====
app.get("/", (_req, res) => res.send("✅ AI proxy up (persistent)"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// ===== Learning API =====
// クライアントから来た好き/嫌い語をサーバーにも永続蓄積
app.post("/learn", async (req, res) => {
  if (!okAuth(req, res)) return;
  const likeArr    = take(req.body?.like, 200);
  const dislikeArr = take(req.body?.dislike, 200);
  Learn.addLike(likeArr);
  Learn.addDislike(dislikeArr);
  await Learn.save().catch(()=>{});
  res.json({ ok: true, ...Learn.export(), path: LEARN_PATH });
});

app.get("/learn", (_req, res) => {
  res.json({ ok: true, ...Learn.export(), path: LEARN_PATH });
});

app.post("/learn/reset", async (req, res) => {
  if (!okAuth(req, res)) return;
  await Learn.reset().catch(()=>{});
  res.json({ ok: true, ...Learn.export(), path: LEARN_PATH });
});

// ===== Analyze（簡易判定 + 学習反映） =====
// 入力: { items:[{id,text}], like_tokens?:[], dislike_tokens?:[] }
// 出力: { results: { [id]: { suggest:"keep"|"hide"|"rewrite" } } }
app.post("/analyze", (req, res) => {
  if (!okAuth(req, res)) return;

  const items    = take(req.body?.items, 50);
  const likeIn   = new Set((req.body?.like_tokens    || []).map(toStr));
  const dislikeIn= new Set((req.body?.dislike_tokens || []).map(toStr));

  // クライアント提供 + サーバー学習 を合成
  const likeAll    = new Set([...likeIn,    ...Learn.like]);
  const dislikeAll = new Set([...dislikeIn, ...Learn.dislike]);

  const out = {};
  for (const it of items) {
    const id   = toStr(it?.id) || ("h" + Math.random().toString(36).slice(2));
    const text = toStr(it?.text || "");
    const low  = text.toLowerCase();

    let suggest = "keep";

    // 学習「嫌い」語 → hide に寄せる
    for (const w of dislikeAll) {
      if (w && low.includes(String(w).toLowerCase())) { suggest = "hide"; break; }
    }

    // 簡易の不快語ヒント
    const badHints = [
      "死ね","バカ","クソ","最悪","消えろ","ムカつく","キモい","うざい","ぶっ殺",
      "fuck","shit","idiot","moron","kill you"
    ];
    if (suggest === "keep") {
      for (const w of badHints) {
        if (low.includes(w.toLowerCase())) { suggest = "hide"; break; }
      }
    }

    // 学習「好き」語 → rewrite へ（丁寧化やAJのターゲットへ送れる）
    if (suggest === "keep") {
      for (const w of likeAll) {
        if (w && low.includes(String(w).toLowerCase())) { suggest = "rewrite"; break; }
      }
    }

    out[id] = { suggest };
  }

  res.json({ results: out });
});

// ===== Rewrite（校閲/AJ） =====
// 入力: { style:"polish"|"american_joke"|..., items:[{id,text}] }
// 出力: { results:{ [id]:"書き換え後" } }
app.post("/rewrite", async (req, res) => {
  if (!okAuth(req, res)) return;
  try {
    const style = toStr(req.body?.style || "polish").slice(0, 200).toLowerCase();
    const items = take(req.body?.items, 40);

    const joined = items
      .map(it => `${toStr(it?.id)}::: ${toStr(it?.text)}`.slice(0, 4000))
      .join("\n\n")
      .slice(0, 16000);

    if (!joined.trim()) return res.json({ results: {} });

    let sys = "";
    if (style.includes("american_joke")) {
      sys = "あなたは日本語のジョーク作家です。各入力（id::: text）を短く軽快なアメリカンジョーク風に、攻撃性を避けつつ意味を保って書き換え、JSONオブジェクト（{\"id\":\"変換後\"...}）のみ返してください。";
    } else {
      sys = "あなたは日本語の編集者です。各入力（id::: text）を自然で丁寧に穏やかに校閲し、攻撃的表現は和らげて、JSONオブジェクト（{\"id\":\"変換後\"...}）のみ返してください。";
    }

    let content;
    try {
      content = await callOpenAIChat({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: sys },
          { role: "user",   content: joined }
        ]
      });
    } catch (e) {
      // フォールバック：原文
      const out = {};
      for (const it of items) out[toStr(it?.id)] = toStr(it?.text || "");
      return res.json({ results: out, fallback: true, error: toStr(e.message || e) });
    }

    let parsed = {};
    try { parsed = JSON.parse(content); }
    catch (_e) {
      const out = {};
      for (const it of items) out[toStr(it?.id)] = toStr(it?.text || "");
      return res.json({ results: out, fallback: true, parse_error: true, raw: content });
    }

    const results = {};
    for (const it of items) {
      const id = toStr(it?.id);
      const v  = toStr(parsed[id]);
      results[id] = v || toStr(it?.text || "");
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: toStr(e.message || e) });
  }
});

// ===== 1件用（投稿前にサッと変換） =====
app.post("/rewrite-post", async (req, res) => {
  if (!okAuth(req, res)) return;
  try {
    const text = toStr(req.body?.text || "");
    const mode = toStr(req.body?.mode || "polish").toLowerCase();
    if (!text.trim()) return res.json({ text: "" });

    const sys = mode.includes("american_joke")
      ? "短く軽快なアメリカンジョーク風。意味は保ち、攻撃的表現は避け、軽いオチで締める。日本語で。"
      : "攻撃的/下品/暴言を和らげ、自然で丁寧な日本語に校閲する。意味は保つ。";

    const out = await callOpenAIChat({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user",   content: text }
      ]
    });

    res.json({ text: toStr(out) });
  } catch (e) {
    res.status(500).json({ error: toStr(e.message || e) });
  }
});

// ===== Start =====
app.listen(PORT, () => console.log(`✅ server up on :${PORT}, learn=${LEARN_PATH}`));
