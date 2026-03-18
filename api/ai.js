// api/ai.js - Part 1/3
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// -------------------- Environment & Service Setup --------------------
function mustEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = mustEnv("OPENAI_API_KEY");
const ALLOW_DEBUG = process.env.ALLOW_DEBUG === "true";
const OWNER_USER_ID = mustEnv("OWNER_USER_ID");

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// -------------------- Models & Plan --------------------
const MODELS = {
  CHAT_FAST: "gpt-4o-mini",
  CHAT_SMART: "gpt-5-mini",
  // IMAGE removed entirely
  EMBEDDING: "text-embedding-3-small", // optional
};

const PLAN = {
  free: {
    gpt_5_4_nano_tokens: 150_000,
    gpt_5_4_mini_tokens: 10_000,
    max_output_tokens: 500,
    detailed_tokens: 1000,
    image_generation: 0,
    uploads_per_month: 3,
  },
  plus: {
    gpt_5_nano_tokens: 1_000_000,
    gpt_5_4_mini_tokens: 350_000,
    max_output_tokens: 500,
    detailed_tokens: 1500,
    image_generation: 0,
    uploads_per_month: 5,
  },
  pro: {
    gpt_5_4_nano_tokens: 1_500_000,
    gpt_5_4_mini_tokens: 1_000_000,
    max_output_tokens: 500,
    detailed_tokens: 2000,
    image_generation: 0,
    uploads_per_month: 10,
  },
};

// -------------------- Tables --------------------
const TABLES = {
  usageMonthly: "ai_usage_monthly",
  uploadsMonthly: "ai_uploads_monthly",
  throttle: "ai_throttle_minute",
  conversations: "ai_conversations",
  weakTopics: "ai_weak_topics",
  costUsage: "ai_cost_usage",
  cacheExact: "ai_cache_exact",
  cacheSemantic: "ai_cache_semantic",
};

// -------------------- Generic Helpers --------------------
const json = (res, code, obj) => res.status(code).json(obj);
const safeString = (v) => (v && v.trim() ? v.trim() : null);
const isObject = (v) =>
  v && typeof v === "object" && !Array.isArray(v) && v !== null;
const nowISO = () => new Date().toISOString();
const monthKeyUTC = () => new Date().toISOString().slice(0, 7);
const minuteBucketUTC = () =>
  new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const hashText = (v) => crypto.createHash("sha256").update(v).digest("hex");

// -------------------- Tier Helpers --------------------
function normalizeTier(input) {
  if (!input) return "free";
  const tier = input.toLowerCase();
  if (tier === "plus") return "plus";
  if (tier === "pro") return "pro";
  return "free";
}
function planForTier(tier) {
  return PLAN[normalizeTier(tier)] || PLAN.free;
}
function getMonthlyLimitForModel(tier, modelKey) {
  const plan = planForTier(tier);
  return plan[modelKey] ?? 0;
}

// -------------------- Prompt Helpers --------------------
function isDetailedPrompt(text) {
  return /\b(detailed|explain|step[- ]?by[- ]?step|in[- ]?depth)\b/i.test(
    text
  );
}

// -------------------- UX Helpers --------------------
function upgradeOutOfUsageMessage() {
  return "You have reached your monthly token limit. Upgrade your plan to continue.";
}
function tooLargeMessage() {
  return "Input exceeds the allowed size limit.";
}

// -------------------- Request Metadata --------------------
function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.socket.remoteAddress ||
    "unknown"
  );
}
function basicBotFlag(req) {
  const ua = req.headers["user-agent"] || "";
  return /bot|curl|wget|python/i.test(ua);
}

// -------------------- Response Helpers --------------------
function cleanReplyText(text) {
  return text
    .replace(/```/g, "")
    .replace(/[\r\n]{2,}/g, "\n")
    .trim();
}
function sanitizeHistory(history) {
  return (history || [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
}

// -------------------- Semantic Cache Helpers --------------------
const SEMANTIC_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "in",
  "on",
  "with",
  "for",
  "to",
]);

function semanticPreNormalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(past paper|summarise|summarize|summary)\b/g, (m) =>
      m === "past paper" ? "pastpaper" : "summary"
    )
    .replace(/\s+/g, " ")
    .trim();
}

function stemSemanticToken(token) {
  return token.replace(/(ing|ed|es|s)$/, "");
}

function semanticTokens(text) {
  return Array.from(
    new Set(
      semanticPreNormalize(text)
        .split(" ")
        .filter((t) => !SEMANTIC_STOPWORDS.has(t))
        .map(stemSemanticToken)
    )
  ).sort();
}

function semanticNormalizeText(text) {
  return semanticTokens(text).join(" ");
}

function semanticSimilarity(aText, bText) {
  const aTokens = new Set(semanticTokens(aText));
  const bTokens = new Set(semanticTokens(bText));
  const intersection = new Set([...aTokens].filter((x) => bTokens.has(x)));
  const union = new Set([...aTokens, ...bTokens]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function semanticMatchGoodEnough(currentText, candidateText) {
  const normA = semanticNormalizeText(currentText);
  const normB = semanticNormalizeText(candidateText);
  if (normA.length < 20) return normA === normB;
  return semanticSimilarity(normA, normB) > 0.75;
}

function qualityBucketForModel(model) {
  if (/gpt-5/.test(model)) return "smart";
  return "fast";
}

function tierBucketForTier(tier) {
  return tier === "free" ? "free" : "paid";
}

function exactCacheKey(version, action, userId, tier, modelQuality, question) {
  return [
    version,
    action,
    userId,
    tierBucketForTier(tier),
    modelQuality,
    question.trim(),
  ].join("|");
}

function semanticCacheKey(version, action, userId, tier, modelQuality, question) {
  // user-scoped semantic cache
  return [
    version,
    action,
    userId,
    tierBucketForTier(tier),
    modelQuality,
    semanticNormalizeText(question),
  ].join("|");
}

function cacheMetaFor(userId, tier, model) {
  return { _cache_meta: { userId, tier, model } };
}

function stripPrivateCacheMeta(payload) {
  if (payload && payload._cache_meta) {
    delete payload._cache_meta;
  }
  return payload;
}

// -------------------- Auth Helpers --------------------
async function getAuthUser(req) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.split("Bearer ")[1]?.trim();
  if (!token) return { error: "Missing Bearer token" };
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return { error: "Invalid token" };
  return { user: data.user, accessToken: token };
}

// -------------------- User Settings --------------------
async function ensureUserSettingsRow(userId) {
  const { data, error } = await supabaseAdmin
    .from("user_settings")
    .select("*")
    .eq("user_id", userId)
    .single();
  if (!data) {
    await supabaseAdmin.from("user_settings").insert({
      user_id: userId,
      tier: "free",
      created_at: nowISO(),
    });
  }
}

async function getUserSettings(userId) {
  try {
    await ensureUserSettingsRow(userId);
    const { data, error } = await supabaseAdmin
      .from("user_settings")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (error || !data) return { tier: "free" };
    return { tier: normalizeTier(data.tier) };
  } catch (err) {
    return { tier: "free" };
  }
}
// api/ai.js - Part 2/3

// -------------------- Database Tracking Helpers --------------------
async function usageKey(userId, month, model) {
  return { user_id: userId, month, model };
}

async function loadMonthlyUsage(userId, month, model) {
  const { data } = await supabaseAdmin
    .from(TABLES.usageMonthly)
    .select("input,output,used")
    .eq("user_id", userId)
    .eq("month", month)
    .eq("model", model)
    .single();
  return data || { input: 0, output: 0, used: 0 };
}

async function bumpMonthlyUsage(userId, month, model, incInput, incOutput) {
  // Atomic RPC recommended
  const { data, error } = await supabaseAdmin.rpc(
    "ai_usage_atomic_increment",
    {
      p_user_id: userId,
      p_month: month,
      p_model: model,
      p_inc_input: incInput,
      p_inc_output: incOutput,
    }
  );
  if (error) throw error;
  return data;
}

async function loadUploadsCount(userId, month) {
  const { data } = await supabaseAdmin
    .from(TABLES.uploadsMonthly)
    .select("count")
    .eq("user_id", userId)
    .eq("month", month)
    .single();
  return data?.count ?? 0;
}

async function bumpUploadsCount(userId, month, increment) {
  const count = await loadUploadsCount(userId, month);
  await supabaseAdmin.from(TABLES.uploadsMonthly).upsert({
    user_id: userId,
    month,
    count: count + increment,
  });
}

async function throttleCheckAndBump(userId, bucket, limitPerMinute) {
  const { data } = await supabaseAdmin
    .from(TABLES.throttle)
    .select("count")
    .eq("user_id", userId)
    .eq("bucket", bucket)
    .single();
  const current = data?.count ?? 0;
  if (current >= limitPerMinute) return false;
  await supabaseAdmin.from(TABLES.throttle).upsert({
    user_id: userId,
    bucket,
    count: current + 1,
  });
  return true;
}

// -------------------- Optional Tables --------------------
async function saveConversationMessage(userId, role, content) {
  await supabaseAdmin.from(TABLES.conversations).insert({
    user_id: userId,
    role,
    content,
    created_at: nowISO(),
  });
}

async function getWeakTopics(userId) {
  const { data } = await supabaseAdmin
    .from(TABLES.weakTopics)
    .select("*")
    .eq("user_id", userId)
    .order("incorrect_count", { ascending: false });
  return data || [];
}

// -------------------- Attachment Handling --------------------
function safeBase64DataUrl(mime, base64) {
  if (!mime || !base64) throw new Error("Invalid attachment");
  return `data:${mime};base64,${base64}`;
}

async function parseAttachments(arr) {
  if (!Array.isArray(arr)) return [];
  const attachments = [];
  for (const att of arr.slice(0, 3)) {
    if (att.base64) attachments.push(safeBase64DataUrl(att.mime, att.base64));
  }
  return attachments;
}

function hasAnyAttachment(attachments) {
  return attachments && attachments.length > 0;
}

function buildContentWithAttachments(text, attachments) {
  const content = [];
  for (const att of attachments) content.push({ type: "input_file", content: att });
  content.push({ type: "input_text", content: text });
  return content;
}

// -------------------- Prompt Building --------------------
function baseStylePrompt() {
  return "Respond in plain text only. Keep formatting neat. No Markdown or asterisks.";
}

function tutorPrompt() {
  return `You are ReviseFlow AI, a GCSE study tutor. Explain step-by-step. ${baseStylePrompt()}`;
}

function systemPromptFor(userId, action, question, attachmentsPresent, weakTopics) {
  // Owner gets generic prompt
  if (userId === OWNER_USER_ID) return `Generic AI Assistant. ${baseStylePrompt()}`;
  return tutorPrompt();
}

function actionInstruction(action) {
  switch (action) {
    case "flashcards":
    case "mark":
    case "summarise":
    case "diagram":
    case "revision-plan":
    case "weakness":
      return "Return strictly JSON output for frontend parsing.";
    default:
      return "Return plain text answer.";
  }
}

// -------------------- OpenAI API Helpers --------------------
async function openaiResponsesCall(body) {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error("OpenAI API call failed");
  return await resp.json();
}

function extractOutputText(resp) {
  if (resp.output_text) return resp.output_text;
  if (resp.output?.length) {
    return resp.output.map((o) => o.content?.[0]?.text).filter(Boolean).join("\n");
  }
  return "";
}

function getUsageTokens(resp) {
  return resp?.usage ?? { input: 0, output: 0, total: 0 };
}

function buildResponsesRequestBody(model, input, maxOutput, reasoning, verbosity) {
  const body = { model, input, max_output_tokens: maxOutput };
  if (reasoning) body.reasoning = { effort: reasoning };
  if (verbosity) body.text = { verbosity };
  return body;
}

// -------------------- Router / Model Selection --------------------
function heuristicDifficulty(action, question, attachmentsPresent) {
  const long = question.length > 300;
  const hasAttachment = attachmentsPresent;
  if (action === "mark" || action === "diagram") return "hard";
  if (long || hasAttachment) return "hard";
  return "simple";
}

async function chooseMainModelForRequest(userTier, action, question, attachmentsPresent) {
  const tier = normalizeTier(userTier);
  const fastModel = MODELS.CHAT_FAST;
  const smartModel = MODELS.CHAT_SMART;

  // Free tier always uses fast model
  if (tier === "free") {
    return { model: fastModel, reasoning: "low", verbosity: "low" };
  }

  // Paid tiers logic
  const isDetailed = isDetailedPrompt(question);
  const reasoning = isDetailed ? "medium" : "low";
  const verbosity = isDetailed ? "medium" : "low";

  // Decide model usage based on available token budget
  const model = smartModel;
  return { model, reasoning, verbosity };
}
// api/ai.js - Part 3/3

// -------------------- Output Parsing / Normalization --------------------
function tryParseJsonLoose(text) {
  try { return JSON.parse(text); } catch {}
  try {
    const cleaned = text.replace(/```[\s\S]*?```/g, "");
    return JSON.parse(cleaned);
  } catch {}
  const matchObj = text.match(/\{[\s\S]*\}/);
  if (matchObj) try { return JSON.parse(matchObj[0]); } catch {}
  const matchArr = text.match(/\[[\s\S]*\]/);
  if (matchArr) try { return JSON.parse(matchArr[0]); } catch {}
  return null;
}

function normalizeFlashcards(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 20).map(({ q, a }) => ({ q, a }));
}

function normalizeMarking(parsed) {
  return {
    score: clamp(parsed.score ?? 0, 0, 100),
    strengths: parsed.strengths || [],
    missing: parsed.missing || [],
    feedback: parsed.feedback || "",
    topic: parsed.topic || "",
  };
}

function normalizeSummary(parsed) {
  return {
    summary: parsed.summary || "",
    key_points: parsed.key_points || [],
    exam_tips: parsed.exam_tips || [],
    topic: parsed.topic || "",
  };
}

function normalizeDiagram(parsed) {
  return {
    overview: parsed.overview || "",
    parts: parsed.parts || [],
    topic: parsed.topic || "",
  };
}

function normalizeRevisionPlan(parsed) {
  return {
    title: parsed.title || "",
    daily_plan: parsed.daily_plan || [],
    advice: parsed.advice || "",
  };
}

function normalizeWeakness(parsed) {
  return {
    weak_topics: parsed.weak_topics || [],
    next_steps: parsed.next_steps || [],
    advice: parsed.advice || "",
    topic: parsed.topic || "",
  };
}

// -------------------- Streaming Helpers --------------------
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function sendSseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamFinalChatResponse(res, finalResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sendSseEvent(res, "meta", { timestamp: nowISO() });
  const chunks = finalResponse.split(" ").reduce((acc, word, idx) => {
    if (!acc[acc.length - 1] || acc[acc.length - 1].length > 18) acc.push(word);
    else acc[acc.length - 1] += " " + word;
    return acc;
  }, []);
  for (const c of chunks) {
    sendSseEvent(res, "delta", { text: c });
    await sleep(16);
  }
  sendSseEvent(res, "done", {});
  res.end();
}
async function openaiResponsesStream(body, onDelta) {
  const resp = await fetch("https://api.openai.com/v1/responses?stream=true", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) throw new Error("OpenAI API call failed");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n\n");
    buffer = lines.pop(); // keep last incomplete line

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const payload = line.slice(6);
        if (payload === "[DONE]") break;
        try {
          const deltaObj = JSON.parse(payload);
          const token = deltaObj?.output_text_delta || deltaObj?.delta?.content?.[0]?.text;
          if (token) onDelta(token);
        } catch {}
      }
    }
  }
}
// -------------------- Main Handler --------------------
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  const debug = body.debug === true;

  // -------- Authentication / Tier Setup --------
  const { user, error: authErr } = await getAuthUser(req);
  if (authErr || !user) return res.status(401).json({ error: "Invalid or missing token" });

  const tier = (await getUserSettings(user.id))?.tier || "free";
  const month = monthKeyUTC();

  // -------- Rate limiting --------
  const ip = getClientIp(req);
  const suspicious = basicBotFlag(req);
  const limitPerMinute = tier === "free" ? 20 : 60;
  const allowed = await throttleCheckAndBump(user.id, minuteBucketUTC(), suspicious ? Math.floor(limitPerMinute/2) : limitPerMinute);
  if (!allowed) return res.status(429).json({ error: "Rate limit exceeded" });

  // -------- Action dispatch --------
  const action = body.action || "chat";
  const question = body.question || body.prompt || "";
  const attachments = await parseAttachments(body.attachments || []);

  // -------- System prompt --------
  const weakTopics = await getWeakTopics(user.id);
  const systemPrompt = systemPromptFor(user.id, action, question, hasAnyAttachment(attachments), weakTopics);
  const actionInstr = actionInstruction(action);

  // -------- Build AI content --------
  const content = buildContentWithAttachments(`${systemPrompt}\n${actionInstr}\n${question}`, attachments);

  // -------- Model selection --------
  const { model, reasoning, verbosity } = await chooseMainModelForRequest(tier, action, question, hasAnyAttachment(attachments));

  // -------- Token allowance check --------
  const maxTokensMap = { free: { normal: 500, detailed: 1000 }, plus: { normal: 500, detailed: 1500 }, pro: { normal: 500, detailed: 2000 } };
  const maxTokens = isDetailedPrompt(question) ? maxTokensMap[tier].detailed : maxTokensMap[tier].normal;

  // -------- Call OpenAI --------
  const requestBody = buildResponsesRequestBody(model, content, maxTokens, reasoning, verbosity);
  let outputText = "";
await openaiResponsesStream(requestBody, (token) => {
  sendSseEvent(res, "delta", { text: token });
  outputText += token;
});
sendSseEvent(res, "done", {});
res.end();
return;
  const usage = getUsageTokens(aiResp);

  // -------- Update usage and logs --------
  await bumpMonthlyUsage(user.id, month, model, usage.input, usage.output);
  await saveConversationMessage(user.id, "user", question);
  await saveConversationMessage(user.id, "assistant", outputText);

  // -------- Parse output based on action --------
  let parsedOutput;
  try {
    const rawParsed = tryParseJsonLoose(outputText);
    switch (action) {
      case "flashcards": parsedOutput = normalizeFlashcards(rawParsed); break;
      case "mark": parsedOutput = normalizeMarking(rawParsed); break;
      case "summarise": parsedOutput = normalizeSummary(rawParsed); break;
      case "diagram": parsedOutput = normalizeDiagram(rawParsed); break;
      case "revision-plan": parsedOutput = normalizeRevisionPlan(rawParsed); break;
      case "weakness": parsedOutput = normalizeWeakness(rawParsed); break;
      default: parsedOutput = outputText;
    }
  } catch { parsedOutput = outputText; }

  // -------- Streaming if requested --------
  if (body.stream === true) return await streamFinalChatResponse(res, outputText);

  // -------- Return JSON --------
  return res.status(200).json({
    model,
    tier,
    question,
    answer: parsedOutput,
    usage,
    attachments_count: attachments.length,
    debug: debug ? { raw_output: outputText } : undefined,
  });
};