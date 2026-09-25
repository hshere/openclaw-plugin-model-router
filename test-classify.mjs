// Test harness: drives the REAL qwen3.5:2b classifier via Ollama using the
// plugin's exact structured-JSON prompt + parsing logic, with category
// descriptions (the "needs current info" disambiguation).
//
// parseCategory below is a faithful port of the production parser in
// src/index.ts: strict JSON only, no substring fallback. This keeps the test
// harness aligned with what actually runs in the plugin.
const BASE = "http://127.0.0.1:11434";

const CATEGORIES = ["general", "code", "reasoning", "chat", "language", "current"];

// Operator-supplied category descriptions (this is the new config knob).
const DESCRIPTIONS = {
  general: "Everyday conversation, small talk, or simple tasks that need no special tooling.",
  code: "Writing, fixing, explaining, or debugging code, scripts, SQL, or technical implementation.",
  reasoning: "Timeless logic, math, proofs, analysis, or planning that does NOT depend on live/current facts.",
  chat: "Casual banter, jokes, roleplay, or creative social conversation.",
  language: "Translation between languages, grammar questions, vocabulary, pronunciation, or language learning.",
  current: "News, current events, prices, stock availability, weather forecasts, sports results, or anything that depends on live/up-to-date information.",
};

function buildClassifierPrompt(prompt) {
  const lines = [
    "You are a routing classifier. Read the user request and choose EXACTLY ONE category.",
    'Reply with a single JSON object of the form {"category": "<label>"} and nothing else.',
    `Valid labels: ${CATEGORIES.join(", ")}.`,
    "",
    "Category meanings:",
  ];
  for (const [k, v] of Object.entries(DESCRIPTIONS)) lines.push(`- ${k}: ${v}`);
  lines.push("", "User request:", prompt);
  return lines.join("\n");
}

function parseCategory(raw, categories) {
  const cleaned = raw.trim();
  if (!cleaned.startsWith("{") || !cleaned.endsWith("}")) return null;
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const label = obj.category;
      if (typeof label === "string") {
        const normalized = label.trim().toLowerCase();
        if (categories.includes(normalized)) return normalized;
      }
    }
  } catch {
    // not valid JSON; reject
  }
  return null;
}

async function classify(prompt) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen3.5:2b",
      stream: false,
      think: false, // qwen3.x thinking model -> disable so content is emitted
      options: { temperature: 0, num_predict: 32 },
      system: 'You are a precise routing classifier. Reply with exactly one JSON object {"category": "<label>"} and nothing else.',
      messages: [{ role: "user", content: buildClassifierPrompt(prompt) }],
    }),
  });
  const data = await res.json();
  const raw = (data?.message?.content ?? "").trim();
  return { category: parseCategory(raw, CATEGORIES) ?? "general", raw, ms: Date.now() - t0 };
}

const PROMPTS = [
  // Original 10
  "What's a good way to say happy birthday to my mom?",
  "Write a Python function that reverses a linked list",
  "Why is the sky blue? Explain the physics.",
  "Summarize this article about climate change in 3 bullets",
  "Fix the bug in my React component where state doesn't update",
  "What should I eat for dinner tonight?",
  "Prove that the square root of 2 is irrational",
  "Translate 'good morning, how are you' into Japanese",
  "Help me debug why my SQL query returns duplicate rows",
  "Tell me a funny joke about programmers",
  // NEW: translation/language category
  "Translate 'good morning, how are you' into Japanese",
  "What does 'bonjour' mean in English?",
  "How do I say 'where is the train station' in French?",
  "What's the difference between 'ser' and 'estar' in Spanish?",
  "Translate this paragraph from German to English: 'Ich habe gestern einen Hund gesehen'",
  // NEW: current-info vs timeless-info disambiguation
  "What's the price of the iPhone 17 Pro Max right now?",
  "Is the PlayStation 5 Pro in stock at Best Buy today?",
  "What's the latest news on the SpaceX Starship launch?",
  "What's the weather in Chicago tomorrow?",
  "Who won the NBA championship last season?",
  "What is the capital of France?",
  "How much is a gallon of milk usually?",
];

const out = [];
for (const p of PROMPTS) {
  const r = await classify(p);
  out.push({ prompt: p, ...r });
}
console.log(JSON.stringify(out, null, 2));
