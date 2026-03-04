// /api/ai.js
// ReviseFlow unified AI endpoint: chat + attachments + DALL·E 2 generation
// Tier rules: free / plus / pro read from public.user_settings.tier (fallback: role)
// Monthly token budgets + monthly image budgets + free attachment allowance
// Production-focused; server-side only.

const { createClient } = require("@supabase/supabase-js");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = mustEnv("OPENAI_API_KEY");

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(res, code, obj) {
  return res.status(code).json(obj);
}

function safeString(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
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

function isDetailedPrompt(text) {
  return /(^|\b)(detailed|in detail|step[- ]by[- ]step|full marks|long answer)(\b|$)/i.test(
    String(text || "")
  );
}

function normalizeTier(input) {
  const r = String(input || "free").toLowerCase().trim();
  if (r === "user") return "free";
  if (r === "free" || r === "plus" || r === "pro" || r === "admin") return r;
  if (r === "basic") return "free";
  if (r === "premium") return "plus";
  return "free";
}

function upgradeOutOfUsageMessage() {
  return [
    "You have run out of AI usage for this month.",
    "If you would like to continue using AI please subscribe to one of our plans:",
    "subscriptions.html",
  ].join(" ");
}

function upgradeFeatureMessage() {
  return [
    "This feature is available on Plus or Pro.",
    "Please upgrade to continue:",
    "subscriptions.html",
  ].join(" ");
}

function badRequest(res, msg) {
  return json(res, 400, { error: msg });
}

function forbidden(res, msg) {
  return json(res, 403, { error: msg });
}

function tooMany(res, msg) {
  return json(res, 429, { error: msg });
}

async function getAuthUser(req) {
  const authHeader = safeString(req.headers.authorization) || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return { error: "Missing auth token" };
  }

  const accessToken = safeString(authHeader.slice(7));
  if (!accessToken) return { error: "Missing auth token" };

  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user?.id) return { error: "Invalid session" };
  return { user: data.user, accessToken };
}

async function getUserSettings(userId) {
  const { data, error } = await supabaseAdmin
    .from("user_settings")
    .select("tier, role, timezone")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("user_settings read error:", error);
  }

  let tier = "free";

  if (data) {
    // PRIORITY: tier column
    if (data.tier && String(data.tier).trim() !== "") {
      tier = String(data.tier).toLowerCase().trim();
    }
    // fallback only if tier missing
    else if (data.role && String(data.role).trim() !== "") {
      tier = String(data.role).toLowerCase().trim();
    }
  }

  // normalize allowed tiers
  if (!["free", "plus", "pro", "admin"].includes(tier)) {
    tier = "free";
  }

  return {
    tier,
    timezone: safeString(data?.timezone) || "UTC",
  };
}

/* =========================
   Models + Plans
   ========================= */

const MODELS = {
  CHAT_FREE: "gpt-4o-mini",
  CHAT_PAID: "gpt-5-mini",
  CHAT_ALT: "gpt-4o-mini",
  VISION: "gpt-5.1",
  DOC_PARSER: "gpt-5-nano",
  IMAGE_MODEL: "dall-e-2",
};

const PLAN = {
  free: {
    tokenLimits: {
      "gpt-4o-mini": 200_000,
      "gpt-5-mini": 0,
      "gpt-5.1": 0,
      "gpt-5-nano": 0,
    },
    visionBudget: 0,
    freeUploadsPerMonth: 5,
    dalle2PerMonth: 0,
    allowUploads: true,
    allowImages: false,
    throttlePerMinute: 10,
  },
  plus: {
    tokenLimits: {
      "gpt-4o-mini": 1_000_000,
      "gpt-5-mini": 1_000_000,
      "gpt-5.1": 0,
      "gpt-5-nano": 0,
    },
    visionBudget: 50_000,
    freeUploadsPerMonth: Infinity,
    dalle2PerMonth: 20,
    allowUploads: true,
    allowImages: true,
    throttlePerMinute: 20,
  },
  pro: {
    tokenLimits: {
      "gpt-4o-mini": 2_000_000,
      "gpt-5-mini": 2_000_000,
      "gpt-5.1": 0,
      "gpt-5-nano": 0,
    },
    visionBudget: 100_000,
    freeUploadsPerMonth: Infinity,
    dalle2PerMonth: 50,
    allowUploads: true,
    allowImages: true,
    throttlePerMinute: 40,
  },
  admin: {
    tokenLimits: {},
    visionBudget: Infinity,
    freeUploadsPerMonth: Infinity,
    dalle2PerMonth: Infinity,
    allowUploads: true,
    allowImages: true,
    throttlePerMinute: 999,
  },
};

function planForTier(tier) {
  if (tier === "admin") return PLAN.admin;
  if (tier === "pro") return PLAN.pro;
  if (tier === "plus") return PLAN.plus;
  return PLAN.free;
}

function chooseDefaultChatModel(tier) {
  if (tier === "free") return MODELS.CHAT_FREE;
  return MODELS.CHAT_PAID;
}

function canUseChatModel(tier, model) {
  if (tier === "admin") return true;
  if (tier === "free") return model === MODELS.CHAT_FREE;
  return model === MODELS.CHAT_FREE || model === MODELS.CHAT_PAID;
}

function getMonthlyLimitForModel(tier, model) {
  if (tier === "admin") return Infinity;
  const p = planForTier(tier);
  return Number(p.tokenLimits?.[model] || 0);
}

/* =========================
   Tables
   ========================= */

const TABLES = {
  usageMonthly: "ai_usage_monthly",
  attachmentsMonthly: "ai_attachments_monthly",
  imageMonthly: "image_usage_monthly",
  throttleMinute: "ai_throttle_minute",
};

function usageKey(userId, month, model) {
  return { user_id: userId, month, model };
}

/* =========================
   Supabase reads/writes
   ========================= */

async function loadMonthlyUsage({ userId, month, model }) {
  // Tolerant read: if columns missing, treat as zero (prevents hard crashes)
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
  const cur = await loadMonthlyUsage({ userId, month, model });

  const nextIn = cur.input + Math.max(0, Number(addInput || 0));
  const nextOut = cur.output + Math.max(0, Number(addOutput || 0));

  const { error } = await supabaseAdmin.from(TABLES.usageMonthly).upsert({
    user_id: userId,
    month,
    model,
    input_tokens: nextIn,
    output_tokens: nextOut,
    updated_at: nowISO(),
  });

  if (error) throw new Error(`Upsert ai_usage_monthly failed: ${error.message}`);

  return { usedAfter: nextIn + nextOut };
}

async function loadUploadsCount({ userId, month }) {
  const { data, error } = await supabaseAdmin
    .from(TABLES.attachmentsMonthly)
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

  const { error } = await supabaseAdmin.from(TABLES.attachmentsMonthly).upsert({
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

  const { error: upErr } = await supabaseAdmin.from(TABLES.throttleMinute).upsert({
    user_id: userId,
    minute_bucket: bucket,
    count: next,
    updated_at: nowISO(),
  });

  if (upErr) throw new Error(`Upsert ai_throttle_minute failed: ${upErr.message}`);

  return { ok: true, bucket, count: next };
}

/* =========================
   Attachments
   ========================= */

function safeBase64DataUrl(mime, base64) {
  const m = String(mime || "").toLowerCase().trim();
  const b = String(base64 || "").trim();
  if (!b || !m) return null;
  if (!/^[a-z0-9]+\/[a-z0-9.+-]+$/.test(m)) return null;
  if (b.length > 18_000_000) return null;
  return `data:${m};base64,${b}`;
}

function parseAttachments(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];

  for (const a of arr) {
    if (!isObject(a)) continue;

    const kind = String(a.kind || "").toLowerCase().trim();
    const filename = safeString(a.filename) || (kind === "pdf" ? "document.pdf" : "image.png");
    const mime = safeString(a.mime) || (kind === "pdf" ? "application/pdf" : "image/png");
    const base64 = safeString(a.base64) || "";

    if (kind !== "pdf" && kind !== "image") continue;
    if (!base64) continue;

    out.push({ kind, filename, mime, base64 });
  }

  return out.slice(0, 3);
}

function hasAnyAttachment(attachments) {
  return Array.isArray(attachments) && attachments.length > 0;
}

function buildContentWithAttachments(question, attachments) {
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

  content.push({ type: "input_text", text: question });
  return content;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-12)
    .map((m) => ({
      role: m.role,
      content: [{ type: "input_text", text: String(m.content || "").slice(0, 6000) }],
    }));
}

/* =========================
   Vision budget logic
   ========================= */

async function chooseModelForRequest({ userId, tier, month, attachmentsPresent }) {
  if (!attachmentsPresent) {
    return { model: chooseDefaultChatModel(tier), visionUsed: false, reason: "no-attachments" };
  }

  if (tier === "admin") {
    return { model: MODELS.VISION, visionUsed: true, reason: "admin" };
  }

  if (tier !== "plus" && tier !== "pro") {
    // free attachments allowed (limited); process with free model
    return { model: MODELS.CHAT_FREE, visionUsed: false, reason: "free-attachments" };
  }

  const p = planForTier(tier);
  const visionLimit = Number(p.visionBudget || 0);

  const used = (await loadMonthlyUsage({ userId, month, model: MODELS.VISION })).used;
  const remaining = Math.max(0, visionLimit - used);

  if (remaining > 0) {
    return { model: MODELS.VISION, visionUsed: true, reason: "vision-budget" };
  }

  return { model: chooseDefaultChatModel(tier), visionUsed: false, reason: "fallback-after-vision" };
}

async function requireTokensOrUpgrade({ userId, tier, month, model, expectedMaxSpend }) {
  if (tier === "admin") return { ok: true, remaining: Infinity };

  let limit;
  if (model === MODELS.VISION) {
    limit = Number(planForTier(tier).visionBudget || 0);
  } else {
    limit = getMonthlyLimitForModel(tier, model);
  }

  if (limit <= 0) return { ok: false, remaining: 0, reason: "not-in-plan" };

  const used = (await loadMonthlyUsage({ userId, month, model })).used;
  const remaining = Math.max(0, limit - used);

  if (remaining <= 0) return { ok: false, remaining, reason: "out" };

  if (typeof expectedMaxSpend === "number" && expectedMaxSpend > 0) {
    if (remaining < expectedMaxSpend) return { ok: false, remaining, reason: "insufficient" };
  }

  return { ok: true, remaining };
}

/* =========================
   OpenAI calls
   ========================= */

function extractOutputText(resp) {
  const out = resp?.output;
  if (Array.isArray(out) && out.length) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        const t = content.find((c) => c?.type === "output_text")?.text;
        if (t) return t;
      }
    }
  }
  return resp?.output_text || null;
}

function getUsageTokens(resp) {
  const usage = resp?.usage || {};
  const inTok = Number(usage.input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  return { input: inTok, output: outTok, total: inTok + outTok };
}

async function openaiResponsesCall({ model, input, maxOutputTokens, temperature }) {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens: maxOutputTokens,
      temperature: typeof temperature === "number" ? temperature : 0.7,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || "OpenAI Responses request failed";
    throw new Error(msg);
  }

  return data;
}

async function openaiDalle2Generate({ prompt, size }) {
  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "dall-e-2",
      prompt,
      size,
      response_format: "url",
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || "OpenAI Images request failed");
  }

  const url = data?.data?.[0]?.url || null;
  return { url };
}

/* =========================
   Main handler
   ========================= */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const auth = await getAuthUser(req);
    if (auth.error) return json(res, 401, { error: auth.error });

    const userId = auth.user.id;
    const settings = await getUserSettings(userId);
    const tier = settings.tier;

    const p = planForTier(tier);

    const throttle = await throttleCheckAndBump({
      userId,
      maxPerMinute: p.throttlePerMinute,
    });

    if (!throttle.ok) {
      return tooMany(res, "Too many requests. Please wait a moment and try again.");
    }

    const body = isObject(req.body) ? req.body : {};
    const action = String(body.action || "chat").toLowerCase().trim();
    const month = monthKeyUTC();

    // ========= IMAGE GENERATION =========
    if (action === "image") {
      if (!p.allowImages) {
        return forbidden(res, upgradeFeatureMessage());
      }

      const prompt = safeString(body.prompt) || "";
      if (!prompt) return badRequest(res, "No prompt provided");

      const size = "1024x1024";
      const imageModel = MODELS.IMAGE_MODEL;

      if (tier !== "admin") {
        const limit = Number(p.dalle2PerMonth || 0);
        const { count } = await loadMonthlyImageCount({ userId, month, model: imageModel });
        if (!(limit === Infinity) && count >= limit) {
          return tooMany(res, "You have reached your monthly image generation limit.");
        }
      }

      const perMinuteHard = tier === "pro" ? 8 : 4;
      if (throttle.count > perMinuteHard) {
        return tooMany(res, "Too many image requests too quickly. Please wait a minute.");
      }

      const result = await openaiDalle2Generate({ prompt, size });
      if (!result.url) return json(res, 500, { error: "Image generated but no URL returned." });

      if (tier !== "admin") {
        await bumpMonthlyImageCount({ userId, month, model: imageModel, inc: 1 });
      }

      const { count } = await loadMonthlyImageCount({ userId, month, model: imageModel });
      const remainingImages =
        tier === "admin" ? "Unlimited" : Math.max(0, Number(p.dalle2PerMonth) - Number(count));

      return json(res, 200, {
        image_url: result.url,
        model: imageModel,
        size,
        tier,
        month,
        remaining_images: remainingImages,
      });
    }

    // ========= CHAT =========
    const question = safeString(body.question || body.topic) || "";
    if (!question) return badRequest(res, "No question provided");

    const history = sanitizeHistory(body.history);
    const requestedModel = safeString(body.model) || "";

    const attachments = parseAttachments(body.attachments);
    const attachmentsPresent = hasAnyAttachment(attachments);

    if (attachmentsPresent) {
      if (!p.allowUploads) return forbidden(res, upgradeFeatureMessage());

      if (tier === "free") {
        const { count } = await loadUploadsCount({ userId, month });
        if (count >= PLAN.free.freeUploadsPerMonth) {
          return forbidden(
            res,
            "You have used your 5 free uploads for this month. Please upgrade to Plus or Pro: subscriptions.html"
          );
        }
      }
    }

    // model selection (requested only if allowed)
    let baseModel = chooseDefaultChatModel(tier);
    if (requestedModel) {
      if (!canUseChatModel(tier, requestedModel)) {
        return forbidden(res, "Your plan can’t use that model.");
      }
      baseModel = requestedModel;
    }

    // choose final model (vision if attachments and budget remains)
    const chosen = await chooseModelForRequest({
      userId,
      tier,
      month,
      attachmentsPresent,
    });

    let model = chosen.model || baseModel;
    if (!canUseChatModel(tier, model) && model !== MODELS.VISION) {
      model = chooseDefaultChatModel(tier);
    }

    let maxOutputTokens = 450;
    if (isDetailedPrompt(question)) maxOutputTokens = 900;

    // Ensure budget before calling OpenAI
    if (tier !== "admin") {
      const pre = await requireTokensOrUpgrade({
        userId,
        tier,
        month,
        model,
        expectedMaxSpend: maxOutputTokens,
      });

      if (!pre.ok) {
        return tooMany(res, upgradeOutOfUsageMessage());
      }
    }

    let content;
    try {
      content = buildContentWithAttachments(question, attachments);
    } catch (e) {
      return badRequest(res, e.message || "Bad attachment");
    }

    const inputPayload = [
      ...history,
      {
        role: "user",
        content,
      },
    ];

    const data = await openaiResponsesCall({
      model,
      input: inputPayload,
      maxOutputTokens,
      temperature: 0.7,
    });

    const reply = extractOutputText(data) || "No response generated.";
    const usage = getUsageTokens(data);

    if (tier !== "admin") {
      await bumpMonthlyUsage({
        userId,
        month,
        model,
        addInput: usage.input,
        addOutput: usage.output,
      });
    }

    if (attachmentsPresent && tier === "free") {
      await bumpUploadsCount({ userId, month, inc: 1 });
    }

    // remaining tokens across plan buckets
    const limits = {
      "gpt-4o-mini": getMonthlyLimitForModel(tier, "gpt-4o-mini"),
      "gpt-5-mini": getMonthlyLimitForModel(tier, "gpt-5-mini"),
      "gpt-5.1": tier === "plus" ? PLAN.plus.visionBudget : tier === "pro" ? PLAN.pro.visionBudget : 0,
    };

    async function remainingFor(modelName) {
      if (tier === "admin") return "Unlimited";

      const lim =
        modelName === "gpt-5.1"
          ? Number(limits["gpt-5.1"] || 0)
          : Number(limits[modelName] || 0);

      const used = (await loadMonthlyUsage({ userId, month, model: modelName })).used;
      return Math.max(0, lim - used);
    }

    const remaining_tokens = {
      "gpt-4o-mini": await remainingFor("gpt-4o-mini"),
      "gpt-5-mini": await remainingFor("gpt-5-mini"),
      "gpt-5.1": await remainingFor("gpt-5.1"),
    };

    return json(res, 200, {
      reply,
      tier,
      month,
      model_used: model,
      vision_used: chosen.visionUsed,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        total_tokens: usage.total,
      },
      plan_limits: limits,
      remaining_tokens,
      upgrade_url: "subscriptions.html",
      attachments: {
        submitted: attachments.length,
        free_monthly_allowance: tier === "free" ? PLAN.free.freeUploadsPerMonth : "Unlimited",
        free_used_this_month: tier === "free" ? (await loadUploadsCount({ userId, month })).count : undefined,
      },
    });
  } catch (error) {
    console.error("Server error:", error);
    return json(res, 500, { error: "Server error" });
  }
};