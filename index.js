import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Set OPENAI_API_KEY in environment (Railway Variables)");
  process.exit(1);
}

const SHARED_SECRET = process.env.SHARED_SECRET || "";

function requireAuth(req, res) {
  if (!SHARED_SECRET) return true;
  const token = req.headers["x-proxy-secret"];
  if (token && token === SHARED_SECRET) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

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
      temperature: 0.7,
      ...(response_format ? { response_format } : {}),
      max_tokens: 1200,
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = j?.error?.message || `OpenAI HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j?.choices?.[0]?.message?.content || "";
}

app.get("/", (_req, res) => res.send("✅ AI proxy up"));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

app.post("/analyze", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { items } = req.body;
  try {
    const prompt = `以下の文章を分析し、不快または有害な投稿を判定してください。
安全であれば "keep"、軽いジョークであれば "rewrite"、不快であれば "hide" としてください。
JSONで返してください: ${JSON.stringify(items.slice(0, 5))}`;
    const aiResponse = await callOpenAIChat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });
    res.json({ results: aiResponse });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/rewrite", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { text } = req.body;
  try {
    const joke = await callOpenAIChat({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a funny comedian making American jokes." },
        { role: "user", content: `次の文を軽いアメリカンジョーク風に変えて: ${text}` },
      ],
    });
    res.json({ joke });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
