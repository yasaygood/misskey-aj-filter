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

// ==== 認証（任意） ====
function requireAuth(req, res) {
  if (!SHARED_SECRET) return true;
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// ==== OpenAI 呼び出し（chat.completions）====
async function callOpenAIChat({ model, messages, response_format }) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
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

// ==== ヘルスチェック ====
app.get("/", (_req, res) => res.send("✅ AI proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

// ==== Chat（そのまま残す）====
app.post("/chat", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { messages, model = "gpt-4o-mini" } = req.body;
    if (!messages) return res.status(400).json({ error: "messages is required" });
    const result = await callOpenAIChat({ model, messages });
    res.json({ reply: result });
  } catch (e) {
    console.error("❌ /chat error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ==== Analyze（VMの /analyze 呼び出し用）====
app.post("/analyze", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { items = [], level = "moderate", like_tokens = [], dislike_tokens = [] } = req.body;

    const sys = `Misskeyノートのテキストを評価し、JSONオブジェクトで返す。
- key: 受け取った id
- value: { suggest: "keep"|"rewrite"|"hide" }

判定指針:
- 強い罵倒/攻撃/性表現/露骨な下ネタ/差別/ハラスメント/連投的発狂（例: ああああ）があれば "hide"
- 皮肉/ネガ/空中リプ（具体指し示しが薄い@だけ等）は "rewrite" 推奨
- それ以外は "keep"

レベル:
- relaxed: hideを弱め、rewrite多め
- moderate: バランス
- strict: hideを強め

学習トークン:
- like_tokens に近い文面は keep 寄り
- dislike_tokens に近い文面は hide/rewrite 寄り

必ず純粋なJSONのみを返す。`;

    const user = JSON.stringify({
      level,
      like_tokens,
      dislike_tokens,
      items, // [{id,text}]
    });

    const raw = await callOpenAIChat({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(raw);
    // もしモデルが {"a1":"hide"} 形式で返したら包む
    const results = parsed.results ? parsed.results : parsed;
    res.json({ results });
  } catch (e) {
    console.error("❌ /analyze error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ==== Rewrite（VMの /rewrite 呼び出し用）====
app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { style = "american_joke", items = [] } = req.body; // [{id,text}]
    const sys =
      style.indexOf("american_joke") >= 0
        ? `次の各テキストを短いアメリカンジョーク調に。否定性はやわらげ、意味は保つ。最後は軽い落ち。JSONで {id:text} 形式だけ返す。`
        : `次の各テキストを指定
