// /api/ai.js
// ReviseFlow unified AI endpoint
// Features:
// - chat
// - optional chat streaming for typing effect
// - image generation
// - image label pack generation for blank-label diagrams
// - flashcard generation
// - exam marking
// - diagram explanation
// - summarisation
// - revision planning
// - weakness tracking
// - conversation memory
// - token usage tracking
// - monthly limits
// - anti-spam throttling
// - attachment support (base64 or Supabase Storage)
// - owner special behavior
// - exact + semantic cache
// - two-stage routing (gpt-4o-mini router, gpt-5-mini for harder paid requests)
// - cost tracking
//
// Models used:
// - gpt-4o-mini
// - gpt-5-mini
// - gpt-image-1
// - text-embedding-3-small (reserved for future upgrades; semantic cache below is schema-safe)

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

/* =========================
   Environment
   ========================= */

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing env var: ${name}`);
  }
  return String(v).trim();
}

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = mustEnv("OPENAI_API_KEY");

const ALLOW_DEBUG = String(process.env.ALLOW_DEBUG || "").toLowerCase() === "true";
const OWNER_USER_ID = "6bb7cfe9-1b9e-4edd-a79e-287dd2ae7ee1";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* =========================
   Constants
   ========================= */

const MODELS = {
  CHAT_FAST: "gpt-4o-mini",
  CHAT_SMART: "gpt-5-mini",
  IMAGE: "gpt-image-1",
  EMBEDDING: "text-embedding-3-small",
};

const PLAN = {
  free: {
    tokenLimits: {
      "gpt-4o-mini": 300_000,
      "gpt-5-mini": 0,
    },
    imagesPerMonth: 10,
    freeUploadsPerMonth: 5,
    throttlePerMinute: 10,
  },
  plus: {
    tokenLimits: {
      "gpt-4o-mini": 1_000_000,
      "gpt-5-mini": 1_000_000,
    },
    imagesPerMonth: 40,
    freeUploadsPerMonth: Infinity,
    throttlePerMinute: 20,
  },
  pro: {
    tokenLimits: {
      "gpt-4o-mini": 2_000_000,
      "gpt-5-mini": 2_000_000,
    },
    imagesPerMonth: 100,
    freeUploadsPerMonth: Infinity,
    throttlePerMinute: 40,
  },
};

const TABLES = {
  usageMonthly: "ai_usage_monthly",
  uploadsMonthly: "ai_attachments_monthly",
  imageMonthly: "image_usage_monthly",
  throttleMinute: "ai_throttle_minute",
  conversations: "ai_conversations",
  topicStats: "ai_topic_stats",
  costUsage: "ai_cost_usage",
  cache: "ai_response_cache",
};

const MAX_ATTACHMENTS = 3;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 6000;
const MAX_REQUEST_CHARS = 12000;
const MAX_BASE64_LEN = 18_000_000;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const MAX_CONVERSATION_LOG_CHARS = 12000;
const DEFAULT_IMAGE_SIZE = "512x512";
const SEMANTIC_CACHE_VERSION = "semantic-v2";
const SEMANTIC_CACHE_SCAN_LIMIT = 60;
const ROUTER_MAX_OUTPUT_TOKENS = 180;
const ROUTER_EXPECTED_SPEND = 220;
const IMAGE_LABELS_EXPECTED_SPEND = 320;

const IMAGE_COST_REFERENCE = {
  "512x512": {
    low: 0.008,
    medium: 0.02,
    high: 0.08,
  },
};

/* =========================
   Generic helpers
   ========================= */

function json(res, code, obj) {
  return res.status(code).json(obj);
}

function safeString(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nowISO() {
  return new Date().toISOString();
}

function monthKeyUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function minuteBucketUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da}T${hh}:${mm}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function hashText(v) {
  return crypto.createHash("sha256").update(String(v || "")).digest("hex");
}

function normalizeTier(input) {
  const r = String(input || "free").toLowerCase().trim();
  if (r === "free" || r === "plus" || r === "pro") return r;
  if (r === "user" || r === "basic") return "free";
  if (r === "premium") return "plus";
  return "free";
}

function planForTier(tier) {
  if (tier === "pro") return PLAN.pro;
  if (tier === "plus") return PLAN.plus;
  return PLAN.free;
}

function getMonthlyLimitForModel(tier, model) {
  return Number(planForTier(tier).tokenLimits?.[model] || 0);
}

function isDetailedPrompt(text) {
  return /(^|\b)(detailed|in detail|step[- ]by[- ]step|full marks|long answer|thoroughly|deeply|comprehensive)(\b|$)/i.test(
    String(text || "")
  );
}

function isStudyRelated(text) {
  const s = String(text || "").toLowerCase();
  return /gcse|a-?level|revision|revise|exam|past paper|mark scheme|homework|worksheet|biology|chemistry|physics|maths|math|english|history|geography|photosynthesis|equation|derive|calculate|explain|6[- ]marker|12[- ]marker|flashcard|summari[sz]e|tutor|study|diagram|cell|osmosis|respiration|algebra|poetry|language paper|science/.test(
    s
  );
}

function maxOutputTokensForAction(action, text) {
  if (action === "flashcards") return 1200;
  if (action === "mark") return 900;
  if (action === "revision-plan") return 1200;
  if (action === "summarise") return 1200;
  if (action === "diagram") return 900;
  if (action === "weakness") return 900;
  return isDetailedPrompt(text) ? 900 : 450;
}

function upgradeOutOfUsageMessage() {
  return "You have run out of AI usage for this month. Please upgrade in subscriptions.html to continue.";
}

function tooLargeMessage() {
  return "That request is too large. Please shorten the message or reduce attachments.";
}

function getClientIp(req) {
  const xff = safeString(req.headers["x-forwarded-for"]);
  if (xff) return xff.split(",")[0].trim();
  return safeString(req.headers["x-real-ip"]) || "unknown";
}

function basicBotFlag(req) {
  const ua = String(req.headers["user-agent"] || "").toLowerCase();
  if (!ua) return true;
  return /curl|wget|python|httpclient|insomnia|postmanruntime|node-fetch|axios/i.test(ua);
}

function cleanReplyText(text) {
  let t = String(text || "");
  t = t.replace(/\*\*(.*?)\*\*/g, "$1");
  t = t.replace(/^\s*\*\s+/gm, "- ");
  t = t.replace(/```[a-z]*\n?/gi, "");
  t = t.replace(/```+/g, "");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role,
      content: [
        {
          type: "input_text",
          text: String(m.content || "").slice(0, MAX_HISTORY_CHARS),
        },
      ],
    }));
}

function toPositiveInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function asJsonObject(v) {
  if (isObject(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return isObject(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

function deepCloneJson(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch (_) {
    return v;
  }
}

function isGpt5Family(model) {
  return /^gpt-5/i.test(String(model || ""));
}



function priceRefForImageSize(size) {
  return IMAGE_COST_REFERENCE[size] || null;
}

function chooseVerbosityForAction(action, text) {
  if (action === "mark") return "medium";
  if (action === "revision-plan") return "medium";
  if (action === "summarise") return "medium";
  if (action === "diagram") return "medium";
  return isDetailedPrompt(text) ? "medium" : "low";
}

function chooseReasoningEffortForRoute(routeDifficulty, action) {
  if (action === "mark") return "medium";
  if (routeDifficulty === "hard") return "medium";
  return "low";
}

/* =========================
   Semantic cache helpers
   Schema-safe: uses response_json metadata
   ========================= */

const SEMANTIC_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "do", "does", "for", "from",
  "give", "how", "i", "in", "is", "it", "me", "of", "on", "or", "please", "tell", "the", "this",
  "to", "what", "when", "where", "which", "who", "why", "with", "would", "you", "your", "about",
  "explain", "describe", "show", "write", "make", "create", "help", "understand", "work", "works"
]);

function semanticPreNormalize(text) {
  let s = String(text || "").toLowerCase();
  s = s.replace(/what is /g, " ");
  s = s.replace(/how does /g, " ");
  s = s.replace(/tell me about /g, " ");
  s = s.replace(/can you /g, " ");
  s = s.replace(/please /g, " ");
  s = s.replace(/step by step/g, " ");
  s = s.replace(/past paper/g, " pastpaper ");
  s = s.replace(/mark scheme/g, " markscheme ");
  s = s.replace(/6 marker/g, " 6marker ");
  s = s.replace(/12 marker/g, " 12marker ");
  s = s.replace(/photosynthetic/g, " photosynthesis ");
  s = s.replace(/respiring/g, " respiration ");
  s = s.replace(/organisms/g, " organism ");
  s = s.replace(/cells/g, " cell ");
  s = s.replace(/equations/g, " equation ");
  s = s.replace(/diagrams/g, " diagram ");
  s = s.replace(/summarise/g, " summary ");
  s = s.replace(/summarize/g, " summary ");
  s = s.replace(/flashcards/g, " flashcard ");
  s = s.replace(/revision plan/g, " revisionplan ");
  s = s.replace(/[^a-z0-9\s]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function stemSemanticToken(token) {
  let t = String(token || "").trim();
  if (!t) return "";
  if (t.length > 6 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 5 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 5 && t.endsWith("es")) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith("s")) t = t.slice(0, -1);
  return t;
}

function semanticTokens(text) {
  const raw = semanticPreNormalize(text);
  if (!raw) return [];
  const out = [];
  const seen = new Set();

  for (const part of raw.split(" ")) {
    const t = stemSemanticToken(part);
    if (!t) continue;
    if (SEMANTIC_STOPWORDS.has(t)) continue;
    if (t.length < 2) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }

  out.sort();
  return out;
}

function semanticNormalizeText(text) {
  return semanticTokens(text).join(" ");
}

function semanticSimilarity(aText, bText) {
  const a = new Set(semanticTokens(aText));
  const b = new Set(semanticTokens(bText));

  if (!a.size || !b.size) return { score: 0, jaccard: 0, containment: 0 };

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }

  const union = new Set([...a, ...b]).size;
  const jaccard = union ? intersection / union : 0;
  const containment = intersection / Math.min(a.size, b.size);
  const score = (jaccard * 0.45) + (containment * 0.55);

  return { score, jaccard, containment };
}

function semanticMatchGoodEnough(currentText, candidateText) {
  const currentTokens = semanticTokens(currentText);
  const candidateTokens = semanticTokens(candidateText);

  if (!currentTokens.length || !candidateTokens.length) return false;
  if (currentTokens.length < 2 || candidateTokens.length < 2) {
    return currentTokens.join(" ") === candidateTokens.join(" ");
  }

  const { score, containment } = semanticSimilarity(currentText, candidateText);
  return score >= 0.84 || containment >= 0.9;
}

function qualityBucketForModel(model) {
  return model === MODELS.CHAT_SMART ? "smart" : "fast";
}

function tierBucketForTier(tier) {
  return tier === "free" ? "free" : "paid";
}

function exactCacheKey({ action, tier, model, question, userId }) {
  return `exact:${hashText(JSON.stringify({
    v: SEMANTIC_CACHE_VERSION,
    action,
    user: userId,
    tier: tierBucketForTier(tier),
    quality: qualityBucketForModel(model),
    q: String(question || "").trim(),
  }))}`;
}

function semanticCacheKey({ action, tier, model, question, userId }) {
  return `semantic:${hashText(JSON.stringify({
    v: SEMANTIC_CACHE_VERSION,
    action,
    user: userId,
    tier: tierBucketForTier(tier),
    quality: qualityBucketForModel(model),
    q: semanticNormalizeText(question),
  }))}`;
}

function cacheMetaFor({ action, tier, model, question }) {
  return {
    version: SEMANTIC_CACHE_VERSION,
    action,
    tier_bucket: tierBucketForTier(tier),
    quality_bucket: qualityBucketForModel(model),
    semantic_prompt: semanticNormalizeText(question),
    question_preview: String(question || "").slice(0, 200),
  };
}

function stripPrivateCacheMeta(payload) {
  const obj = asJsonObject(payload);
  if (!obj) return payload;
  const cloned = deepCloneJson(obj);
  delete cloned._cache_meta;
  return cloned;
}

/* =========================
   Auth
   ========================= */

function extractBearerFromAuthHeader(req) {
  const authHeader = safeString(req.headers.authorization) || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  return safeString(authHeader.slice(7)) || null;
}

function extractTokenFromBackupHeaders(req) {
  const h1 = safeString(req.headers["x-access-token"]);
  const h2 = safeString(req.headers["x-supabase-token"]);
  return h1 || h2 || null;
}

function extractTokenFromBody(reqBody) {
  if (!isObject(reqBody)) return null;
  return safeString(reqBody.access_token) || null;
}

async function getAuthUser(req, reqBody) {
  const token =
    extractBearerFromAuthHeader(req) ||
    extractTokenFromBackupHeaders(req) ||
    extractTokenFromBody(reqBody);

  if (!token) return { error: "Missing auth token" };

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) return { error: "Invalid session" };
  return { user: data.user, accessToken: token };
}

/* =========================
   User settings
   ========================= */

async function ensureUserSettingsRow(userId) {
  const existing = await supabaseAdmin
    .from("user_settings")
    .select("user_id,tier")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) return { row: null, error: existing.error };
  if (existing.data) return { row: existing.data, error: null };

  const inserted = await supabaseAdmin
    .from("user_settings")
    .insert({ user_id: userId, tier: "free" })
    .select("user_id,tier")
    .maybeSingle();

  if (inserted.error) return { row: null, error: inserted.error };
  return { row: inserted.data, error: null };
}

async function getUserSettings(userId) {
  const { row, error } = await ensureUserSettingsRow(userId);
  if (error) {
    console.error("user_settings read error:", error);
    return { tier: "free" };
  }
  return { tier: normalizeTier(row?.tier) };
}

/* =========================
   DB tracking
   ========================= */

function usageKey(userId, month, model) {
  return { user_id: userId, month, model };
}

async function loadMonthlyUsage({ userId, month, model }) {
  const { data, error } = await supabaseAdmin
    .from(TABLES.usageMonthly)
    .select("*")
    .match(usageKey(userId, month, model))
    .maybeSingle();

  if (error) throw new Error(`Load ai_usage_monthly failed: ${error.message}`);

  const input = Number(data?.input_tokens || 0);
  const output = Number(data?.output_tokens || 0);
  return { input, output, used: input + output };
}

async function bumpMonthlyUsage({ userId, month, model, addInput, addOutput }) {
  const { data, error } = await supabaseAdmin.rpc("ai_usage_atomic_increment", {
  p_user_id: userId,
  p_month: month,
  p_model: model,
  p_input: Math.max(0, Number(addInput || 0)),
  p_output: Math.max(0, Number(addOutput || 0)),
});

if (error) throw new Error(`Atomic usage update failed: ${error.message}`);
return { usedAfter: Number(data || 0) };

async function loadUploadsCount({ userId, month }) {
  const { data, error } = await supabaseAdmin
    .from(TABLES.uploadsMonthly)
    .select("uploads_count")
    .eq("user_id", userId)
    .eq("month", month)
    .maybeSingle();

  if (error) throw new Error(`Load ai_attachments_monthly failed: ${error.message}`);
  return { count: Number(data?.uploads_count || 0) };
}

async function bumpUploadsCount({ userId, month, inc }) {
  const cur = await loadUploadsCount({ userId, month });
  const next = cur.count + Math.max(0, Number(inc || 0));

  const { error } = await supabaseAdmin.from(TABLES.uploadsMonthly).upsert({
    user_id: userId,
    month,
    uploads_count: next,
    updated_at: nowISO(),
  });

  if (error) throw new Error(`Upsert ai_attachments_monthly failed: ${error.message}`);
  return { countAfter: next };
}

async function loadMonthlyImageCount({ userId, month, model }) {
  const { data, error } = await supabaseAdmin
    .from(TABLES.imageMonthly)
    .select("count")
    .eq("user_id", userId)
    .eq("month", month)
    .eq("model", model)
    .maybeSingle();

  if (error) throw new Error(`Load image_usage_monthly failed: ${error.message}`);
  return { count: Number(data?.count || 0) };
}

async function bumpMonthlyImageCount({ userId, month, model, inc = 1 }) {
  const cur = await loadMonthlyImageCount({ userId, month, model });
  const next = cur.count + Math.max(0, Number(inc || 0));

  const { error } = await supabaseAdmin.from(TABLES.imageMonthly).upsert({
    user_id: userId,
    month,
    model,
    count: next,
    updated_at: nowISO(),
  });

  if (error) throw new Error(`Upsert image_usage_monthly failed: ${error.message}`);
  return { countAfter: next };
}

async function throttleCheckAndBump({ userId, maxPerMinute }) {
  const bucket = minuteBucketUTC();

  const { data, error } = await supabaseAdmin
    .from(TABLES.throttleMinute)
    .select("count")
    .eq("user_id", userId)
    .eq("minute_bucket", bucket)
    .maybeSingle();

  if (error) throw new Error(`Load ai_throttle_minute failed: ${error.message}`);

  const current = Number(data?.count || 0);
  if (current >= maxPerMinute) return { ok: false, bucket, count: current };

  const next = current + 1;

const { error: upErr } = await supabaseAdmin
  .from(TABLES.throttleMinute)
  .upsert(
    {
      user_id: userId,
      minute_bucket: bucket,
      count: next,
      updated_at: nowISO(),
    },
    { onConflict: "user_id,minute_bucket" }
  );

if (upErr) throw new Error(`Upsert ai_throttle_minute failed: ${upErr.message}`);
return { ok: true, bucket, count: next };

async function checkMonthlyTokenAllowance({ userId, tier, month, model, expectedMaxSpend }) {
  const limit = getMonthlyLimitForModel(tier, model);
  if (limit <= 0) return { ok: false, remaining: 0, reason: "not-in-plan" };

  const used = (await loadMonthlyUsage({ userId, month, model })).used;
  const remaining = Math.max(0, limit - used);

  if (remaining <= 0) return { ok: false, remaining, reason: "out" };
  if (typeof expectedMaxSpend === "number" && expectedMaxSpend > 0 && remaining < expectedMaxSpend) {
    return { ok: false, remaining, reason: "insufficient" };
  }

  return { ok: true, remaining };
}

/* =========================
   Optional tables
   ========================= */

async function saveConversationMessage(userId, role, message, action = "chat") {
  const msg = safeString(message);
  if (!msg) return;

  try {
    await supabaseAdmin.from(TABLES.conversations).insert({
      user_id: userId,
      role,
      message: msg.slice(0, MAX_CONVERSATION_LOG_CHARS),
      action,
      created_at: nowISO(),
    });
  } catch (_) {
    // optional table
  }
}

async function loadConversationMemory(userId, limit = 8) {
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLES.conversations)
      .select("role,message")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !Array.isArray(data)) return [];

    return data
      .reverse()
      .filter((x) => x && (x.role === "user" || x.role === "assistant"))
      .map((x) => ({
        role: x.role,
        content: [{ type: "input_text", text: String(x.message || "").slice(0, 6000) }],
      }));
  } catch (_) {
    return [];
  }
}

async function bumpTopicWeakness(userId, topic, inc = 1) {
  const t = safeString(topic);
  if (!t) return;

  try {
    const { data } = await supabaseAdmin
      .from(TABLES.topicStats)
      .select("incorrect_count")
      .eq("user_id", userId)
      .eq("topic", t)
      .maybeSingle();

    const next = Number(data?.incorrect_count || 0) + inc;
    await supabaseAdmin.from(TABLES.topicStats).upsert({
      user_id: userId,
      topic: t,
      incorrect_count: next,
      updated_at: nowISO(),
    });
  } catch (_) {
    // optional table
  }
}

async function getWeakTopics(userId, limit = 6) {
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLES.topicStats)
      .select("topic,incorrect_count")
      .eq("user_id", userId)
      .order("incorrect_count", { ascending: false })
      .limit(limit);

    if (error || !Array.isArray(data)) return [];
    return data.map((x) => x.topic).filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function bumpCostUsage(userId, month, tokens) {
  try {
    const { data } = await supabaseAdmin
      .from(TABLES.costUsage)
      .select("tokens")
      .eq("user_id", userId)
      .eq("month", month)
      .maybeSingle();

    const next = Number(data?.tokens || 0) + Math.max(0, Number(tokens || 0));
    await supabaseAdmin.from(TABLES.costUsage).upsert({
      user_id: userId,
      month,
      tokens: next,
      updated_at: nowISO(),
    });
  } catch (_) {
    // optional table
  }
}

async function getCachedResponse(cacheKey) {
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLES.cache)
      .select("response_json")
      .eq("cache_key", cacheKey)
      .maybeSingle();

    if (error || !data?.response_json) return null;
    return data.response_json;
  } catch (_) {
    return null;
  }
}

async function setCachedResponse(cacheKey, responseJson) {
  try {
    await supabaseAdmin.from(TABLES.cache).upsert({
      cache_key: cacheKey,
      response_json: responseJson,
      updated_at: nowISO(),
    });
  } catch (_) {
    // optional table
  }
}

async function getRecentSemanticCacheCandidates(limit = SEMANTIC_CACHE_SCAN_LIMIT) {
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLES.cache)
      .select("cache_key,response_json,updated_at")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error || !Array.isArray(data)) return [];
    return data;
  } catch (_) {
    return [];
  }
}

async function getBestSemanticCachedResponse({ action, tier, model, question }) {
  const currentSemantic = semanticNormalizeText(question);
  if (!currentSemantic) return null;

  const candidates = await getRecentSemanticCacheCandidates();
  let best = null;

  for (const row of candidates) {
    const payload = asJsonObject(row?.response_json);
    if (!payload) continue;

    const meta = payload?._cache_meta;
    if (!isObject(meta)) continue;
    if (meta.version !== SEMANTIC_CACHE_VERSION) continue;
    if (meta.action !== action) continue;
    if (meta.tier_bucket !== tierBucketForTier(tier)) continue;
    if (meta.quality_bucket !== qualityBucketForModel(model)) continue;

    const candidateSemantic = String(meta.semantic_prompt || "");
    if (!candidateSemantic) continue;
    if (!semanticMatchGoodEnough(currentSemantic, candidateSemantic)) continue;

    const sim = semanticSimilarity(currentSemantic, candidateSemantic);

    if (!best || sim.score > best.score) {
      best = {
        score: sim.score,
        row,
        payload,
      };
    }
  }

  if (!best) return null;

  const cleaned = stripPrivateCacheMeta(best.payload);
  if (isObject(cleaned)) {
    cleaned.cache_hit = "semantic";
    cleaned.cache_similarity = Number(best.score.toFixed(3));
  }
  return cleaned;
}

/* =========================
   Attachments
   ========================= */

function safeBase64DataUrl(mime, base64) {
  const m = String(mime || "").toLowerCase().trim();
  const b = String(base64 || "").trim();
  if (!b || !m) return null;
  if (!/^[a-z0-9]+\/[a-z0-9.+-]+$/.test(m)) return null;
  if (b.length > MAX_BASE64_LEN) return null;
  return `data:${m};base64,${b}`;
}

async function downloadFromStorage(bucket, path) {
  const b = safeString(bucket) || "ai-uploads";
  const p = safeString(path);
  if (!p) return null;

  const { data, error } = await supabaseAdmin.storage.from(b).download(p);
  if (error || !data) return null;

  const ab = await data.arrayBuffer();
  if (!ab || ab.byteLength > MAX_DOWNLOAD_BYTES) return null;

  return Buffer.from(ab).toString("base64");
}

async function parseAttachments(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];

  for (const a of arr) {
    if (!isObject(a)) continue;

    const kind = String(a.kind || "").toLowerCase().trim();
    const filename = safeString(a.filename) || (kind === "pdf" ? "document.pdf" : "image.png");
    const mime = safeString(a.mime) || (kind === "pdf" ? "application/pdf" : "image/png");

    if (kind !== "pdf" && kind !== "image") continue;

    if (a.path) {
      const base64 = await downloadFromStorage(a.bucket, a.path);
      if (!base64) continue;
      out.push({ kind, filename, mime, base64 });
    } else {
      const base64 = safeString(a.base64) || "";
      if (!base64) continue;
      out.push({ kind, filename, mime, base64 });
    }

    if (out.length >= MAX_ATTACHMENTS) break;
  }

  return out;
}

function hasAnyAttachment(attachments) {
  return Array.isArray(attachments) && attachments.length > 0;
}

function buildContentWithAttachments(text, attachments) {
  const content = [];

  for (const a of attachments) {
    if (a.kind === "pdf") {
      const dataUrl = safeBase64DataUrl(a.mime || "application/pdf", a.base64);
      if (!dataUrl) throw new Error("Bad PDF attachment (mime/base64).");
      content.push({
        type: "input_file",
        filename: a.filename || "document.pdf",
        file_data: dataUrl,
      });
    } else if (a.kind === "image") {
      const dataUrl = safeBase64DataUrl(a.mime || "image/png", a.base64);
      if (!dataUrl) throw new Error("Bad image attachment (mime/base64).");
      content.push({
        type: "input_image",
        image_url: dataUrl,
      });
    }
  }

  content.push({ type: "input_text", text: String(text || "") });
  return content;
}

/* =========================
   Prompts
   ========================= */

function baseStylePrompt() {
  return (
    "Write in plain text only. Do not use Markdown. " +
    "Do not use asterisks for bullets or bold. " +
    "Keep formatting neat and natural. " +
    "Only use short lists when they genuinely help."
  );
}

function tutorPrompt() {
  return (
    "You are ReviseFlow AI, a strong GCSE and school-study tutor. " +
    "Teach clearly, explain step by step when needed, and give concise exam-focused tips. " +
    "If the user asks a study question, be accurate, practical, and educational. " +
    baseStylePrompt()
  );
}

function generalPrompt() {
  return (
    "You are a helpful, natural AI assistant. " +
    "Be conversational, sensible, and clear. " +
    baseStylePrompt()
  );
}

function systemPromptFor(userId, action, question, attachmentsPresent, weakTopics = []) {
  const study = attachmentsPresent || isStudyRelated(question) || action !== "chat";

  if (String(userId) === OWNER_USER_ID) {
    if (!study) return generalPrompt();
    return (
      tutorPrompt() +
      (weakTopics.length ? ` Focus extra attention on these weak topics if relevant: ${weakTopics.join(", ")}.` : "")
    );
  }

  return (
    tutorPrompt() +
    (weakTopics.length ? ` Focus extra attention on these weak topics if relevant: ${weakTopics.join(", ")}.` : "")
  );
}

function actionInstruction(action) {
  if (action === "flashcards") {
    return (
      "Generate useful revision flashcards. " +
      "Return valid JSON only in this exact shape: " +
      '{"flashcards":[{"q":"question","a":"answer"}]}. ' +
      "Make between 6 and 15 flashcards unless the text is tiny."
    );
  }

  if (action === "mark") {
    return (
      "Mark the student's answer fairly. " +
      "Return valid JSON only in this exact shape: " +
      '{"score_awarded":0,"score_total":0,"strengths":[""],"missing_points":[""],"feedback":"","topic":"optional topic"}.' +
      " Keep marking realistic and exam-style."
    );
  }

  if (action === "summarise") {
    return (
      "Summarise the material clearly for revision. " +
      "Return valid JSON only in this exact shape: " +
      '{"summary":"","key_points":[""],"exam_tips":[""],"topic":"optional topic"}.'
    );
  }

  if (action === "diagram") {
    return (
      "Explain the uploaded or described diagram clearly. " +
      "If the image contains blank label boxes or unreadable text, explain the likely structure based on the visible diagram. " +
      "Return valid JSON only in this exact shape: " +
      '{"overview":"","parts":[{"name":"","explanation":""}],"topic":"optional topic"}.'
    );
  }

  if (action === "revision-plan") {
    return (
      "Create a practical revision plan. " +
      "Return valid JSON only in this exact shape: " +
      '{"plan_title":"","days":[{"day":"Day 1","focus":"","tasks":[""]}],"general_advice":[""]}.'
    );
  }

  if (action === "weakness") {
    return (
      "Based on the user history and weak topics, suggest what to revise next. " +
      "Return valid JSON only in this exact shape: " +
      '{"weak_topics":[""],"next_steps":[""],"advice":"","topic":"optional topic"}.'
    );
  }

  return "Answer the user's request naturally and helpfully. Plain text only.";
}

function buildRouterSystemPrompt() {
  return (
    "You are a routing classifier for an education AI endpoint. " +
    "Return JSON only. " +
    'Shape: {"difficulty":"simple"|"hard","reason":"short reason","recommended_action":"chat"|"flashcards"|"mark"|"diagram"|"summarise"|"revision-plan"|"weakness"}'
  );
}

function buildImageLabelPrompt(prompt) {
  return (
    "Create a concise label pack for an educational diagram request. " +
    "Return JSON only in this exact shape: " +
    '{"title":"","labels":[{"label":"","text":""}]}. ' +
    "Use short textbook-style labels only. " +
    `Request: ${String(prompt || "").trim()}`
  );
}

/* =========================
   OpenAI helpers
   ========================= */

function extractOutputText(resp) {
  const direct = resp?.output_text;
  if (direct && typeof direct === "string") return direct;

  const out = resp?.output;
  if (Array.isArray(out) && out.length) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "output_text" && c?.text) return c.text;
        }
      }
    }
  }

  return null;
}

function getUsageTokens(resp) {
  const usage = resp?.usage || {};
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  return { input, output, total: input + output };
}

function buildResponsesRequestBody({ model, input, maxOutputTokens, reasoningEffort, verbosity }) {
  const body = {
    model,
    input,
    max_output_tokens: maxOutputTokens,
  };

  

  if (isGpt5Family(model)) {
    if (reasoningEffort) {
      body.reasoning = { effort: reasoningEffort };
    }
    if (verbosity) {
      body.text = { ...(body.text || {}), verbosity };
    }
  }

  return body;
}

async function openaiResponsesCall({ model, input, maxOutputTokens, reasoningEffort, verbosity }) {
  const requestBody = buildResponsesRequestBody({
    model,
    input,
    maxOutputTokens,
    reasoningEffort,
    verbosity,
  });

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || "OpenAI Responses request failed";
    throw new Error(msg);
  }

  return data;
}

function buildSafeDiagramImagePrompt(prompt) {
  return (
    String(prompt || "").trim() +
    "\n\nCreate a clean educational diagram." +
    "\nRules:" +
    "\n- Do NOT render readable text inside the image." +
    "\n- If labels are needed, draw empty label boxes or arrows only." +
    "\n- Leave label areas blank instead of producing distorted text." +
    "\n- Focus on shapes, arrows, structures, and clean layout." +
    "\n- White or very light background." +
    "\n- GCSE textbook style." +
    "\n- No gibberish text."
  );
}

async function openaiImageGenerate({ prompt, size, userId }) {
  const guardedPrompt = buildSafeDiagramImagePrompt(prompt);

  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODELS.IMAGE,
      prompt: guardedPrompt,
      size: size || DEFAULT_IMAGE_SIZE,
      user: userId,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || "OpenAI Images request failed");
  }

  const first = data?.data?.[0] || null;
  const b64 = first?.b64_json || null;
  const url = first?.url || null;
  const usage = data?.usage || {};

  if (b64) return { imageUrl: `data:image/png;base64,${b64}`, usage };
  if (url) return { imageUrl: url, usage };

  throw new Error("Image generated but no image data returned");
}

/* =========================
   Router / label helpers
   ========================= */

function heuristicDifficulty(action, question, attachmentsPresent) {
  const q = String(question || "").toLowerCase();
  const longPrompt = q.length > 900;
  const multiQuestion = (q.match(/\?/g) || []).length > 1;
  const complexTerms = /compare|evaluate|assess|analyse|analyze|argue|justify|essay|12[- ]?marker|16[- ]?marker|mark scheme|revision plan|study plan|weakness|improve my answer|grade this|feedback on my answer/.test(q);
  const attachmentHeavy = attachmentsPresent && /explain this|analyse this|analyze this|mark this|summarise this|summary|diagram/.test(q);

  if (action === "mark") return "hard";
  if (action === "revision-plan") return "hard";
  if (action === "weakness") return "hard";
  if (action === "diagram" && attachmentsPresent) return "hard";
  if (longPrompt || multiQuestion || complexTerms || attachmentHeavy) return "hard";

  return "simple";
}

function isLikelyDiagramPrompt(prompt) {
  const q = String(prompt || "").toLowerCase();
  return /diagram|label|biology|cell|chloroplast|leaf|heart|lungs|photosynthesis|plant|gcse|science|structure|arrow|process|annotate/.test(q);
}

async function maybeSpendUsage({ userId, month, model, usage }) {
  const tokens = getUsageTokens({ usage });
  if (tokens.total <= 0) return;
  await bumpMonthlyUsage({
    userId,
    month,
    model,
    addInput: tokens.input,
    addOutput: tokens.output,
  });
  await bumpCostUsage(userId, month, tokens.total);
}

async function runFastRouterModel({ userId, tier, month, action, question, attachmentsPresent }) {
  const allowance = await checkMonthlyTokenAllowance({
    userId,
    tier,
    month,
    model: MODELS.CHAT_FAST,
    expectedMaxSpend: ROUTER_EXPECTED_SPEND,
  });

  if (!allowance.ok) {
    return {
      difficulty: heuristicDifficulty(action, question, attachmentsPresent),
      source: "heuristic-no-fast-router-budget",
      reason: "Skipped router due to remaining fast-model budget.",
      usage: { input: 0, output: 0, total: 0 },
    };
  }

  const input = [
    {
      role: "system",
      content: [{ type: "input_text", text: buildRouterSystemPrompt() }],
    },
    {
      role: "user",
      content: [{
        type: "input_text",
        text: JSON.stringify({
          action,
          question: String(question || ""),
          attachments_present: !!attachmentsPresent,
        }),
      }],
    },
  ];

  try {
    const resp = await openaiResponsesCall({
      model: MODELS.CHAT_FAST,
      input,
      maxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
      verbosity: "low",
    });

    const raw = cleanReplyText(extractOutputText(resp) || "");
    const parsed = tryParseJsonLoose(raw);
    const usage = getUsageTokens(resp);

    await bumpMonthlyUsage({
      userId,
      month,
      model: MODELS.CHAT_FAST,
      addInput: usage.input,
      addOutput: usage.output,
    });
    await bumpCostUsage(userId, month, usage.total);

    const difficulty = parsed?.difficulty === "hard" ? "hard" : "simple";
    const reason = String(parsed?.reason || "").trim() || "Router classified the request.";
    const recommendedAction = String(parsed?.recommended_action || action).trim() || action;

    return {
      difficulty,
      source: "gpt-4o-mini-router",
      reason,
      recommendedAction,
      usage,
    };
  } catch (_) {
    return {
      difficulty: heuristicDifficulty(action, question, attachmentsPresent),
      source: "heuristic-router-fallback",
      reason: "Router fallback used.",
      usage: { input: 0, output: 0, total: 0 },
    };
  }
}

async function chooseMainModelForRequest({ userId, tier, month, action, question, attachmentsPresent }) {
  const heuristic = heuristicDifficulty(action, question, attachmentsPresent);

  if (tier === "free") {
    return {
      model: MODELS.CHAT_FAST,
      difficulty: heuristic,
      source: "free-fast-only",
      reason: "Free tier uses gpt-4o-mini only.",
      router_usage: { input: 0, output: 0, total: 0 },
      reasoning_effort: "low",
      verbosity: chooseVerbosityForAction(action, question),
    };
  }

  const fastAllowance = await checkMonthlyTokenAllowance({
    userId,
    tier,
    month,
    model: MODELS.CHAT_FAST,
    expectedMaxSpend: ROUTER_EXPECTED_SPEND,
  });

  const smartAllowance = await checkMonthlyTokenAllowance({
    userId,
    tier,
    month,
    model: MODELS.CHAT_SMART,
    expectedMaxSpend: maxOutputTokensForAction(action, question),
  });

  if (!fastAllowance.ok && smartAllowance.ok) {
    return {
      model: MODELS.CHAT_SMART,
      difficulty: "hard",
      source: "fallback-smart-no-fast-budget",
      reason: "Fast-model budget unavailable, so the request uses gpt-5-mini.",
      router_usage: { input: 0, output: 0, total: 0 },
      reasoning_effort: "medium",
      verbosity: chooseVerbosityForAction(action, question),
    };
  }

  const router = await runFastRouterModel({
    userId,
    tier,
    month,
    action,
    question,
    attachmentsPresent,
  });

  let selectedModel = MODELS.CHAT_FAST;
  if (router.difficulty === "hard" && smartAllowance.ok) {
    selectedModel = MODELS.CHAT_SMART;
  } else if (!fastAllowance.ok && smartAllowance.ok) {
    selectedModel = MODELS.CHAT_SMART;
  } else {
    selectedModel = MODELS.CHAT_FAST;
  }

  return {
    model: selectedModel,
    difficulty: router.difficulty,
    source: router.source,
    reason: router.reason,
    router_usage: router.usage || { input: 0, output: 0, total: 0 },
    reasoning_effort: chooseReasoningEffortForRoute(router.difficulty, action),
    verbosity: chooseVerbosityForAction(action, question),
  };
}

async function maybeGenerateImageLabels({ userId, tier, month, prompt }) {
  if (!isLikelyDiagramPrompt(prompt)) return null;

  const allowance = await checkMonthlyTokenAllowance({
    userId,
    tier,
    month,
    model: MODELS.CHAT_FAST,
    expectedMaxSpend: IMAGE_LABELS_EXPECTED_SPEND,
  });

  if (!allowance.ok) return null;

  try {
    const resp = await openaiResponsesCall({
      model: MODELS.CHAT_FAST,
      input: [
        {
          role: "system",
          content: [{
            type: "input_text",
            text: "Return JSON only. Keep labels short and clean for GCSE diagrams.",
          }],
        },
        {
          role: "user",
          content: [{
            type: "input_text",
            text: buildImageLabelPrompt(prompt),
          }],
        },
      ],
      maxOutputTokens: 350,
      verbosity: "low",
    });

    const raw = cleanReplyText(extractOutputText(resp) || "");
    const parsed = tryParseJsonLoose(raw);
    const usage = getUsageTokens(resp);

    await bumpMonthlyUsage({
      userId,
      month,
      model: MODELS.CHAT_FAST,
      addInput: usage.input,
      addOutput: usage.output,
    });
    await bumpCostUsage(userId, month, usage.total);

    const normalized = normalizeImageLabels(parsed);
    if (!normalized || !normalized.labels.length) return null;
    return normalized;
  } catch (_) {
    return null;
  }
}

/* =========================
   Parsing model JSON
   ========================= */

function tryParseJsonLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_) {
    // continue
  }

  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // continue
  }

  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch (_) {
      // continue
    }
  }

  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch (_) {
      // continue
    }
  }

  return null;
}

/* =========================
   Response builders
   ========================= */

function normalizeFlashcards(parsed) {
  const cards = Array.isArray(parsed?.flashcards) ? parsed.flashcards : [];
  return cards
    .map((c) => ({
      q: String(c?.q || "").trim(),
      a: String(c?.a || "").trim(),
    }))
    .filter((c) => c.q && c.a)
    .slice(0, 20);
}

function normalizeMarking(parsed) {
  return {
    score_awarded: clamp(Number(parsed?.score_awarded || 0), 0, 100),
    score_total: clamp(Number(parsed?.score_total || 0), 1, 100),
    strengths: Array.isArray(parsed?.strengths) ? parsed.strengths.map(String).slice(0, 8) : [],
    missing_points: Array.isArray(parsed?.missing_points) ? parsed.missing_points.map(String).slice(0, 8) : [],
    feedback: String(parsed?.feedback || "").trim(),
    topic: String(parsed?.topic || "").trim() || null,
  };
}

function normalizeSummary(parsed) {
  return {
    summary: String(parsed?.summary || "").trim(),
    key_points: Array.isArray(parsed?.key_points) ? parsed.key_points.map(String).slice(0, 12) : [],
    exam_tips: Array.isArray(parsed?.exam_tips) ? parsed.exam_tips.map(String).slice(0, 8) : [],
    topic: String(parsed?.topic || "").trim() || null,
  };
}

function normalizeDiagram(parsed) {
  return {
    overview: String(parsed?.overview || "").trim(),
    parts: Array.isArray(parsed?.parts)
      ? parsed.parts
          .map((p) => ({
            name: String(p?.name || "").trim(),
            explanation: String(p?.explanation || "").trim(),
          }))
          .filter((p) => p.name || p.explanation)
          .slice(0, 12)
      : [],
    topic: String(parsed?.topic || "").trim() || null,
  };
}

function normalizeRevisionPlan(parsed) {
  return {
    plan_title: String(parsed?.plan_title || "Revision plan").trim(),
    days: Array.isArray(parsed?.days)
      ? parsed.days
          .map((d) => ({
            day: String(d?.day || "").trim(),
            focus: String(d?.focus || "").trim(),
            tasks: Array.isArray(d?.tasks) ? d.tasks.map(String).slice(0, 8) : [],
          }))
          .filter((d) => d.day || d.focus || d.tasks.length)
          .slice(0, 31)
      : [],
    general_advice: Array.isArray(parsed?.general_advice)
      ? parsed.general_advice.map(String).slice(0, 10)
      : [],
  };
}

function normalizeWeakness(parsed) {
  return {
    weak_topics: Array.isArray(parsed?.weak_topics) ? parsed.weak_topics.map(String).slice(0, 10) : [],
    next_steps: Array.isArray(parsed?.next_steps) ? parsed.next_steps.map(String).slice(0, 10) : [],
    advice: String(parsed?.advice || "").trim(),
    topic: String(parsed?.topic || "").trim() || null,
  };
}

function normalizeImageLabels(parsed) {
  const labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
  return {
    title: String(parsed?.title || "").trim(),
    labels: labels
      .map((x) => ({
        label: String(x?.label || "").trim(),
        text: String(x?.text || "").trim(),
      }))
      .filter((x) => x.label && x.text)
      .slice(0, 12),
  };
}

/* =========================
   Fallback builders
   ========================= */

function fallbackSummary(rawReply) {
  return {
    summary: rawReply || "",
    key_points: [],
    exam_tips: [],
    topic: null,
  };
}

function fallbackDiagram(rawReply) {
  return {
    overview:
      rawReply ||
      "The diagram appears to show a structure or process. If any labels were blank, that was intentional to prevent unreadable AI-generated text.",
    parts: [],
    topic: null,
  };
}

function fallbackRevisionPlan(rawReply) {
  return {
    plan_title: "Revision plan",
    days: [],
    general_advice: rawReply ? [rawReply] : [],
  };
}

function fallbackWeakness(rawReply) {
  return {
    weak_topics: [],
    next_steps: [],
    advice: rawReply || "",
    topic: null,
  };
}

/* =========================
   Streaming helpers
   Optional: send body.stream = true for action=chat
   ========================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function chunkTextForStream(text, target = 18) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length >= target) {
      chunks.push(next + " ");
      current = "";
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  if (!chunks.length && text) chunks.push(String(text));

  return chunks;
}

async function streamFinalChatResponse(res, finalResponse) {
  const reply = String(finalResponse?.reply || "");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  sendSseEvent(res, "meta", {
    action: finalResponse.action,
    tier: finalResponse.tier,
    model_used: finalResponse.model_used,
    routing: finalResponse.routing,
  });

  let built = "";
  const chunks = chunkTextForStream(reply, 20);

  for (const chunk of chunks) {
    built += chunk;
    sendSseEvent(res, "delta", { delta: chunk, text: built });
    await sleep(16);
  }

  sendSseEvent(res, "done", finalResponse);
  res.end();
}

/* =========================
   Main handler
   ========================= */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  const body = isObject(req.body) ? req.body : {};
  const wantsDebug = body.debug === true;

  try {
    const auth = await getAuthUser(req, body);
    if (auth.error) {
      return json(res, 401, {
        error: auth.error,
        hint: "Send Authorization: Bearer <access_token>",
      });
    }

    const userId = auth.user.id;
    const settings = await getUserSettings(userId);
    const tier = settings.tier;
    const plan = planForTier(tier);
    const month = monthKeyUTC();

    const clientIp = getClientIp(req);
    const suspiciousUa = basicBotFlag(req);

    const throttle = await throttleCheckAndBump({
      userId,
      maxPerMinute: suspiciousUa ? Math.max(2, Math.floor(plan.throttlePerMinute / 2)) : plan.throttlePerMinute,
    });

    if (!throttle.ok) {
      return json(res, 429, { error: "Too many requests. Please wait a moment and try again." });
    }

    const action = String(body.action || "chat").toLowerCase().trim();

    /* ========= IMAGE ========= */
    if (action === "image") {
      const prompt = safeString(body.prompt) || safeString(body.question);
      if (!prompt) return json(res, 400, { error: "No prompt provided" });

      if (prompt.length > MAX_REQUEST_CHARS) {
        return json(res, 400, { error: tooLargeMessage() });
      }

      const limit = Number(plan.imagesPerMonth || 0);
      const { count } = await loadMonthlyImageCount({ userId, month, model: MODELS.IMAGE });
      if (!(limit === Infinity) && count >= limit) {
        return json(res, 429, { error: "You have reached your monthly image generation limit." });
      }

      const size = DEFAULT_IMAGE_SIZE;
      const result = await openaiImageGenerate({ prompt, size, userId });

      await bumpMonthlyImageCount({ userId, month, model: MODELS.IMAGE, inc: 1 });

      const imgUsage = {
        input_tokens: Number(result.usage?.input_tokens || 0),
        output_tokens: Number(result.usage?.output_tokens || 0),
        total_tokens: Number(result.usage?.total_tokens || 0),
      };

      if (imgUsage.total_tokens > 0) {
        const fastAllowance = await checkMonthlyTokenAllowance({
          userId,
          tier,
          month,
          model: MODELS.CHAT_FAST,
          expectedMaxSpend: 1,
        });

        if (fastAllowance.ok) {
          await bumpMonthlyUsage({
            userId,
            month,
            model: MODELS.CHAT_FAST,
            addInput: imgUsage.input_tokens,
            addOutput: imgUsage.output_tokens,
          });
        }

        await bumpCostUsage(userId, month, imgUsage.total_tokens);
      }

      const imageLabels =
        body.return_labels === false
          ? null
          : await maybeGenerateImageLabels({ userId, tier, month, prompt });

      const imageCount = await loadMonthlyImageCount({ userId, month, model: MODELS.IMAGE });

      return json(res, 200, {
        image_url: result.imageUrl,
        model: MODELS.IMAGE,
        size,
        tier,
        month,
        remaining_images: Math.max(0, Number(plan.imagesPerMonth) - Number(imageCount.count)),
        usage: imgUsage,
        approx_image_cost_usd: priceRefForImageSize(size),
        image_title: imageLabels?.title || null,
        image_labels: imageLabels?.labels || [],
        label_mode: imageLabels?.labels?.length ? "blank-image-plus-text-labels" : "blank-image-only",
        ...(wantsDebug && (ALLOW_DEBUG || String(userId) === OWNER_USER_ID)
          ? { debug: { userId, tier, clientIp, suspiciousUa, throttle } }
          : {}),
      });
    }

    /* ========= TEXT / MULTIMODAL ========= */

    const question =
      safeString(body.question) ||
      safeString(body.topic) ||
      safeString(body.text) ||
      safeString(body.prompt) ||
      "";

    if (!question) return json(res, 400, { error: "No question provided" });
    if (question.length > MAX_REQUEST_CHARS) return json(res, 400, { error: tooLargeMessage() });

    const attachments = await parseAttachments(body.attachments);
    const attachmentsPresent = hasAnyAttachment(attachments);

    if (attachmentsPresent && tier === "free") {
      const { count } = await loadUploadsCount({ userId, month });
      if (count >= plan.freeUploadsPerMonth) {
        return json(res, 403, {
          error: "You have used your free uploads for this month. Please upgrade in subscriptions.html.",
        });
      }
    }

    const weakTopics = await getWeakTopics(userId, 6);
    const sys = systemPromptFor(userId, action, question, attachmentsPresent, weakTopics);
    const instruction = actionInstruction(action);

    let userText = question;

    if (action === "mark") {
      userText =
        `Question:\n${String(body.question || "")}\n\n` +
        `Student answer:\n${String(body.answer || "")}\n\n` +
        `Mark it carefully and explain the result.`;
    }

    if (action === "revision-plan") {
      const subjects = Array.isArray(body.subjects) ? body.subjects.join(", ") : String(body.subjects || "");
      const days = toPositiveInt(body.days || body.weeks, 7);
      const hours = Number(body.hours_per_week || body.hours || 0);
      userText =
        `Create a revision plan.\nSubjects: ${subjects || "Not provided"}\nDays: ${days}\nHours per week: ${
          hours || "Not provided"
        }\nExtra context: ${question}`;
    }

    if (action === "weakness") {
      userText =
        `User question: ${question}\nKnown weak topics: ${weakTopics.join(", ") || "None recorded"}\nGive next revision steps.`;
    }

    let content;
    try {
      content = buildContentWithAttachments(`${instruction}\n\n${userText}`, attachments);
    } catch (e) {
      return json(res, 400, { error: e.message || "Bad attachment" });
    }

    const routing = await chooseMainModelForRequest({
      userId,
      tier,
      month,
      action,
      question: userText,
      attachmentsPresent,
    });

    let model = routing.model;
    const maxOutputTokens = maxOutputTokensForAction(action, question);

    let allowance = await checkMonthlyTokenAllowance({
      userId,
      tier,
      month,
      model,
      expectedMaxSpend: maxOutputTokens,
    });

    if (!allowance.ok && model === MODELS.CHAT_SMART) {
      const fastFallbackAllowance = await checkMonthlyTokenAllowance({
        userId,
        tier,
        month,
        model: MODELS.CHAT_FAST,
        expectedMaxSpend: maxOutputTokens,
      });

      if (fastFallbackAllowance.ok) {
        model = MODELS.CHAT_FAST;
      } else {
        return json(res, 429, {
          error: upgradeOutOfUsageMessage(),
          ...(wantsDebug && (ALLOW_DEBUG || String(userId) === OWNER_USER_ID)
            ? { debug: { allowance, model, tier } }
            : {}),
        });
      }
    } else if (!allowance.ok) {
      return json(res, 429, {
        error: upgradeOutOfUsageMessage(),
        ...(wantsDebug && (ALLOW_DEBUG || String(userId) === OWNER_USER_ID)
          ? { debug: { allowance, model, tier } }
          : {}),
      });
    }

    const history = sanitizeHistory(body.history);
    const memory = await loadConversationMemory(userId, 8);

    const cacheEligible =
      action === "chat" &&
      !attachmentsPresent &&
      !body.history &&
      String(userId) !== OWNER_USER_ID &&
      isStudyRelated(question);

    const currentExactCacheKey = cacheEligible
  ? exactCacheKey({ action, tier, model, question, userId })
  : null;

    const currentSemanticCacheKey = cacheEligible
  ? semanticCacheKey({ action, tier, model, question, userId })
  : null;

    if (currentExactCacheKey) {
      const exactCached = await getCachedResponse(currentExactCacheKey);
      if (exactCached) {
        const cleaned = stripPrivateCacheMeta(exactCached);
        if (isObject(cleaned)) cleaned.cache_hit = "exact";
        return json(res, 200, cleaned);
      }

      const semanticCached = await getBestSemanticCachedResponse({
        action,
        tier,
        model,
        question,
      });

      if (semanticCached) {
        return json(res, 200, semanticCached);
      }
    }

    const inputPayload = [
      { role: "system", content: [{ type: "input_text", text: sys }] },
      ...memory,
      ...history,
      { role: "user", content },
    ];

    const aiResponse = await openaiResponsesCall({
      model,
      input: inputPayload,
      maxOutputTokens,
      reasoningEffort: isGpt5Family(model) ? routing.reasoning_effort : undefined,
      verbosity: isGpt5Family(model) ? routing.verbosity : undefined,
    });

    let rawReply = extractOutputText(aiResponse) || "";
    rawReply = cleanReplyText(rawReply);

    if (action === "diagram" && !rawReply.trim()) {
      rawReply =
        "The diagram contains visual elements but text labels may have been left blank intentionally to avoid unreadable AI-generated text. Use the arrows, shapes and layout to identify the structure.";
    }

    const usage = getUsageTokens(aiResponse);

    await bumpMonthlyUsage({
      userId,
      month,
      model,
      addInput: usage.input,
      addOutput: usage.output,
    });

    await bumpCostUsage(userId, month, usage.total);

    if (attachmentsPresent && tier === "free") {
      await bumpUploadsCount({ userId, month, inc: 1 });
    }

    await saveConversationMessage(userId, "user", userText, action);

    let responsePayload;

    if (action === "flashcards") {
      const parsed = tryParseJsonLoose(rawReply);
      const flashcards = normalizeFlashcards(parsed);
      responsePayload = {
        flashcards,
        reply: flashcards.length ? "" : rawReply,
      };
    } else if (action === "mark") {
      const parsed = tryParseJsonLoose(rawReply);
      const marked = normalizeMarking(parsed);

      if (marked.topic) {
        const percentage = (marked.score_awarded / Math.max(1, marked.score_total)) * 100;
        if (percentage < 60) await bumpTopicWeakness(userId, marked.topic, 1);
      }

      responsePayload = marked;
    } else if (action === "summarise") {
      const parsed = tryParseJsonLoose(rawReply);
      const summary = parsed ? normalizeSummary(parsed) : fallbackSummary(rawReply);
      if (summary.topic) await saveConversationMessage(userId, "assistant", summary.summary || rawReply, action);
      responsePayload = summary;
    } else if (action === "diagram") {
      const parsed = tryParseJsonLoose(rawReply);
      const diagram = parsed ? normalizeDiagram(parsed) : fallbackDiagram(rawReply);
      if (diagram.topic) await bumpTopicWeakness(userId, diagram.topic, 0);
      responsePayload = diagram;
    } else if (action === "revision-plan") {
      const parsed = tryParseJsonLoose(rawReply);
      responsePayload = parsed ? normalizeRevisionPlan(parsed) : fallbackRevisionPlan(rawReply);
    } else if (action === "weakness") {
      const parsed = tryParseJsonLoose(rawReply);
      responsePayload = parsed ? normalizeWeakness(parsed) : fallbackWeakness(rawReply);
    } else {
      responsePayload = { reply: rawReply };
    }

    const finalResponse = {
      ...responsePayload,
      tier,
      month,
      action,
      model_used: model,
      routing: {
        selected_model: model,
        difficulty: routing.difficulty,
        source: routing.source,
        reason: routing.reason,
      },
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        total_tokens: usage.total,
      },
    };

    const remainingFast = getMonthlyLimitForModel(tier, MODELS.CHAT_FAST);
    const remainingSmart = getMonthlyLimitForModel(tier, MODELS.CHAT_SMART);

    async function remainingFor(modelName, limit) {
      if (!Number.isFinite(limit) || limit <= 0) return 0;
      const used = (await loadMonthlyUsage({ userId, month, model: modelName })).used;
      return Math.max(0, limit - used);
    }

    finalResponse.remaining_tokens = {
      [MODELS.CHAT_FAST]: await remainingFor(MODELS.CHAT_FAST, remainingFast),
      [MODELS.CHAT_SMART]: await remainingFor(MODELS.CHAT_SMART, remainingSmart),
    };

    finalResponse.attachments = {
      submitted: attachments.length,
      free_monthly_allowance: tier === "free" ? plan.freeUploadsPerMonth : "Unlimited",
      free_used_this_month:
        tier === "free" ? (await loadUploadsCount({ userId, month })).count : undefined,
    };

    finalResponse.upgrade_url = "subscriptions.html";

    const assistantLog =
      responsePayload.reply ||
      responsePayload.summary ||
      responsePayload.feedback ||
      responsePayload.advice ||
      responsePayload.plan_title ||
      rawReply;

    await saveConversationMessage(userId, "assistant", assistantLog, action);

    if (cacheEligible && responsePayload.reply) {
      const meta = cacheMetaFor({ action, tier, model, question });
      const cachedCopy = {
        ...deepCloneJson(finalResponse),
        _cache_meta: meta,
      };

      if (currentExactCacheKey) {
        await setCachedResponse(currentExactCacheKey, cachedCopy);
      }

      if (currentSemanticCacheKey && currentSemanticCacheKey !== currentExactCacheKey) {
        await setCachedResponse(currentSemanticCacheKey, cachedCopy);
      }
    }

    if (wantsDebug && (ALLOW_DEBUG || String(userId) === OWNER_USER_ID)) {
      finalResponse.debug = {
        userId,
        clientIp,
        suspiciousUa,
        throttle,
        weakTopics,
        router_usage: routing.router_usage || { input: 0, output: 0, total: 0 },
        authHint: "Use Authorization: Bearer <token>",
      };
    }

    if (body.stream === true && action === "chat" && typeof finalResponse.reply === "string") {
      return await streamFinalChatResponse(res, finalResponse);
    }

    return json(res, 200, finalResponse);

} catch (error) {
  console.error("AI endpoint server error:", error);
  return json(res, 500, {
    error: "AI request failed. Please try again later."
  });
}