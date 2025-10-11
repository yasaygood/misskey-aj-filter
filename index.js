// index.js (dialect+rewrite 強化版)
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ==== ENV ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

// ==== Auth ====
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true;
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// ==== OpenAI ====
async function callOpenAIChat({ model = "gpt-4o-mini", messages, temperature = 0.7, max_tokens = 1200 }) {
  if (!OPENAI_API_KEY) {
    // キー未設定時は“機能的に成功”させるが原文を返す
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

/* ===== Dialect Presets ===== */
const DIALECTS = {
  beranmee: {
    note: "江戸っ子『べらんめえ』口調。荒っぽく陽気。語尾例: 〜だぜ/〜だな/〜じゃねぇか/〜しな。",
    particles: ["ぜ", "じゃん", "だな", "しな", "じゃねぇか"],
  },
  kansai: {
    note: "関西弁。柔らかめでフレンドリー。語尾例: 〜やで/〜やん/〜してな/〜やろ。",
    particles: ["やで", "やん", "してな", "やろ", "せやな"],
  },
  hakata: {
    note: "博多弁。親しみやすく柔らかい。語尾例: 〜やけん/〜っちゃ/〜ばい/〜と？",
    particles: ["やけん", "っちゃ", "ばい", "と？", "たい"],
  },
  tohoku: {
    note: "東北訛りのやさしい口調。語尾例: 〜だべ/〜だっけ/〜すっぺ。",
    particles: ["だべ", "だっけ", "すっぺ", "だはんで"],
  },
  nagoya: {
    note: "名古屋弁の軽いニュアンス。語尾例: 〜だがね/〜だもんで/〜でよ。",
    particles: ["だがね", "だもんで", "でよ", "でかんわ"],
  },
  okinawa: {
    note: "沖縄方言の雰囲気。語尾例: 〜さぁ/〜やっさ/〜どー。",
    particles: ["さぁ", "やっさ", "どー", "ねー"],
  },
  random: { note: "上記から自然に選ぶ。崩しすぎず読みやすく。" },
};

const PLACEHOLDER_GUARD =
  "URL・@メンション・#ハッシュタグ・コード・絵文字などは改変しない。改行数は可能な範囲で保持。";
const REWRITE_RULES =
  "意味は保ちつつ、言い換えを必ず行う。語尾だけでなく、助詞・語順・軽い語彙置換を含めて自然に書き換える。句点・読点は読みやすく整える。罵倒や差別的表現は避ける。";

/** Few-shot 例（軽め） */
function fewshot(dialectKey) {
  const map = {
    beranmee: [
      ["今日は忙しいからまた後で連絡するね。", "今日はバタバタなんだ、あとで連絡するから待ってな。"],
      ["この案が一番良さそう。", "こいつが一番キマってんじゃねぇか。"],
    ],
    kansai: [
      ["今日は忙しいからまた後で連絡するね。", "今日は忙しいさかい、また後で連絡するわ。"],
      ["この案が一番良さそう。", "この案がいっちゃん良さそうやね。"],
    ],
    hakata: [
      ["今日は忙しいからまた後で連絡するね。", "今日は忙しかけん、また後で連絡するばい。"],
    ],
    tohoku: [
      ["今日は忙しいからまた後で連絡するね。", "今日は忙しいはんで、あとで連絡すっからな。"],
    ],
    nagoya: [
      ["今日は忙しいからまた後で連絡するね。", "今日は忙しいでよ、また後で連絡するがね。"],
    ],
    okinawa: [
      ["今日は忙しいからまた後で連絡するね。", "今日は忙しいさぁ、また後で連絡するどー。"],
    ],
  };
  return map[dialectKey] || [];
}

/** プロンプト生成 */
function buildMessages(original, dialectKey, strength = 1.1, mustRewrite = true) {
  let key = dialectKey;
  if (dialectKey === "random") {
    const keys = Object.keys(DIALECTS).filter(k => k !== "random");
    key = keys[Math.floor(Math.random() * keys.length)];
  }
  const d = DIALECTS[key] || DIALECTS.beranmee;

  const intensity =
    strength >= 1.4
      ? "強め（語尾+語彙・語順も積極的に）。"
      : strength >= 1.15
      ? "中程度（語尾+一部語彙・助詞を置換）。"
      : "弱め（主に語尾中心）。";

  const system =
    `あなたは日本語の文体変換アシスタント。` +
    `${PLACEHOLDER_GUARD} ${REWRITE_RULES} ` +
    `方言: ${key}（${d.note}） 変換強度: ${intensity} ` +
    (mustRewrite ? "※同じ文の丸写しは禁止。必ず言い換える。" : "");

  const shots = fewshot(key).flatMap(([u, a]) => [
    { role: "user", content: u },
    { role: "assistant", content: a },
  ]);

  const user =
    `入力文:\n${original}\n---\n出力はこの方言で自然な一段落に。語尾のバリエーション（例: ${ (d.particles||[]).slice(0,3).join(" / ") }）を適度に用いる。`;

  return [{ role: "system", content: system }, ...shots, { role: "user", content: user }];
}

/* ============ routes ============ */
app.get("/", (_req, res) => res.send("AI proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const styleRaw  = String(req.body?.style || "polite_clean");
    const strength  = Number(req.body?.strength ?? 1.15); // 1.0〜1.5
    const mustRw    = Boolean(req.body?.must_rewrite ?? true);
    const items     = Array.isArray(req.body?.items) ? req.body.items : [];

    const out  = {};
    const meta = { route: "rewrite", used: "", dialect: null, styleRaw, strength: strength };

    const isDialect  = styleRaw.startsWith("dialect:");
    const dialectKey = isDialect ? (styleRaw.split(":")[1] || "beranmee") : null;

    for (const it of items) {
      const original = String(it?.text ?? "");
      let rewritten = original;

      if (OPENAI_API_KEY) {
        meta.used = "openai";
        let messages;
        if (isDialect) {
          meta.dialect = dialectKey;
          messages = buildMessages(original, dialectKey, strength, mustRw);
        } else {
          // 非方言（既存互換）
          const base =
            styleRaw.includes("american_joke")
              ? "日本語を短い軽口のウィットに富んだ一行へ。"
              : "日本語をていねいで落ち着いた自然な文へ言い換える。";
          const system = `${base} ${PLACEHOLDER_GUARD} ${mustRw ? "必ず適度に言い換えること。" : ""}`;
          messages = [{ role: "system", content: system }, { role: "user", content: original }];
        }
        rewritten = await callOpenAIChat({ messages, temperature: strength >= 1.3 ? 0.9 : 0.7 });
      } else {
        meta.used = "none"; // 開発用：原文返し
      }

      out[it.id] = (rewritten && rewritten.trim()) ? rewritten.trim() : original;
    }

    res.json({ results: out, meta });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** /filter 互換：単文入力 → 方言へ（内部的に同じロジック） */
app.post("/filter", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const text     = String(req.body?.text || "");
    const dialect  = String(req.body?.dialect || req.body?.mode || "beranmee");
    const strength = Number(req.body?.strength ?? 1.15);
    const mustRw   = Boolean(req.body?.must_rewrite ?? true);
    if (!text) return res.status(400).json({ ok:false, error:"no text" });

    const meta = { route: "filter", used: "", dialect, strength };
    let out = text;

    if (OPENAI_API_KEY) {
      meta.used = "openai";
      const messages = buildMessages(text, dialect, strength, mustRw);
      out = await callOpenAIChat({ messages, temperature: strength >= 1.3 ? 0.9 : 0.7 });
      out = (out && out.trim()) || text;
    } else {
      meta.used = "none";
    }
    res.json({ ok:true, text: out, meta });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

/** 方言一覧 */
app.get("/dialects", (_req, res) => {
  const keys = Object.keys(DIALECTS);
  res.json({ dialects: keys, notes: Object.fromEntries(keys.map(k => [k, DIALECTS[k].note || ""])) });
});

// 起動
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ server on :${PORT}`));
