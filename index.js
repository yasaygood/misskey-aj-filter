import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

// --- CORS: Misskey からのリクエストを許可 ---
app.use(cors({
  origin: true,          // 必要なら "https://misskey.io" に固定してOK
  credentials: false
}));
app.options("*", cors());

// --- JSON パーサ ---
app.use(express.json({ limit: "1mb" }));

// --- ヘルスチェック ---
app.get("/", (req, res) => {
  res.type("text/plain").send("OK");
});

// ==== OpenAI 共通呼び出し ====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4.1-mini";

async function openaiJSON(system, user) {
  const r = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      response_format: { type: "json_object" }
    })
  });

  const data = await r.json();
  // 失敗時そのまま返す
  if (!data?.choices?.[0]?.message?.content) return data;
  // JSON を返す想定
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return data;
  }
}

// ==== 1) 判定API (/moderate) ====
// level: strict | moderate | relaxed
app.post("/moderate", async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const level = (req.query.level || "moderate").toString();

    // Misskey 側の「空リプ／空中リプ」対策（保険）
    const preHidden = new Set();
    const cleaned = items.map(x => {
      const t = (x.text || "").toString();
      const stripped = t
        .replace(/https?:\/\/\S+/g, "")
        .replace(/@\S+/g, "")
        .replace(/[#＃]\S+/g, "")
        .replace(/[\s\n\r]+/g, "")
        .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
      if (!t.trim() || stripped.length === 0) preHidden.add(x.id);
      return { id: x.id, text: t };
    });

    // すでに hide 済み以外を OpenAI に渡す
    const passToAI = cleaned.filter(x => !preHidden.has(x.id));

    let aiMap = {};
    if (passToAI.length) {
      const system = `
あなたはSNSのタイムライン用モデレーターです。
以下のルールに従い、各idに対して "keep" | "rewrite" | "hide" のいずれかを返すJSONを出力してください。

- "hide": 露骨な悪口・誹謗中傷・攻撃的/差別・煽り・露骨な皮肉・過度なネガ・セクシャル・スパム・空中リプで相手を貶す等
- "rewrite": 軽度の愚痴・弱い皮肉・軽ネガ・自虐などはアメリカンジョーク風に再構成可能
- "keep": 問題なし

厳しさレベル:
- strict: より多くを "hide" / "rewrite" に寄せる
- moderate: バランス
- relaxed: 比較的寛容
必ず {"id":"action", ...} の形式。
      `.trim();

      const user = JSON.stringify({
        level,
        items: passToAI
      });

      const out = await openaiJSON(system, user);
      if (out && typeof out === "object") aiMap = out;
    }

    // 事前に弾いたものを追加で hide 指定
    for (const id of preHidden) {
      aiMap[id] = "hide";
    }

    res.json(aiMap);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "moderate failed", detail: String(e?.message || e) });
  }
});

// ==== 2) リライトAPI (/rewrite) ====
// style: american_joke など
app.post("/rewrite", async (req, res) => {
  try {
    const style = (req.body.style || "american_joke").toString();
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    const system = `
あなたは文章のリライターです。与えられたテキストを指定スタイルで書き直し、{"id":"text",...} のJSONを返してください。
条件:
- 誹謗中傷・攻撃性・差別表現・個人攻撃は含めない
- 具体的な個人名・IDへの揶揄は避ける
- 原文の意味を大きく歪めず、明るくユーモラスに
- 出力は必ず id キーを保ったJSON
    `.trim();

    const user = JSON.stringify({
      style,
      items
    });

    const out = await openaiJSON(system, user);
    res.json(out || {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "rewrite failed", detail: String(e?.message || e) });
  }
});

// ==== サーバー起動 ====
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server running on ${port}`);
});