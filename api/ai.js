// /api/ai.js
// ReviseFlow unified AI endpoint: chat + attachments + DALL·E 2 generation
// Tier rules: free / plus / pro from public.user_settings.role
// Monthly token budgets + monthly image budgets + free attachment allowance
// Max ~70 comments; production-focused; server-side only.

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

function normalizeRole(role) {
  const r = String(role || "free").toLowerCase().trim();
  if (r === "user") return "free";
  if (r === "plus" || r === "pro" || r === "admin" || r === "free") return r;
  return "free";
}

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
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

function upgradeHtmlMessage() {
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
    .select("role, timezone")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) {
    return { role: "free", timezone: "UTC" };
  }

  return {
    role: normalizeRole(data.role),
    timezone: safeString(data.timezone) || "UTC",
  };
}

/* =========================
   Plan configuration
   ========================= */

const MODELS = {
  CHAT_FALLBACK_FREE: "gpt-4o-mini",
  CHAT_DEFAULT_PAID: "gpt-5-mini",
  CHAT_ALT: "gpt-4o-mini",
  VISION_PREFERRED: "gpt-5.1",
  DOC_PARSER: "gpt-5-nano",
  IMAGE_MODEL: "dall-e-2",
};

const PLAN = {
  free: {
    period: "monthly",
    tokenLimits: {
      "gpt-4o-mini": 200_000,
      "gpt-5-mini": 0,
      "gpt-5.1": 0,
      "gpt-5-nano": 0,
    },
    visionBudget: 0,
    freeUploadsPerMonth: 5,
    dalle2PerMonth: 0,
    allowUploads: true, // free gets limited uploads
    allowImages: false, // image generation blocked
    throttlePerMinute: 10,
  },
  plus: {
    period: "monthly",
    tokenLimits: {
      "gpt-4o-mini": 1_000_000,
      "gpt-5-mini": 1_000_000,
      "gpt-5.1": 0, // counted via separate budget table bucket
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
    period: "monthly",
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
    period: "none",
    tokenLimits: {},
    visionBudget: Infinity,
    freeUploadsPerMonth: Infinity,
    dalle2PerMonth: Infinity,
    allowUploads: true,
    allowImages: true,
    throttlePerMinute: 999,
  },
};

function planForRole(role) {
  if (role === "admin") return PLAN.admin;
  if (role === "pro") return PLAN.pro;
  if (role === "plus") return PLAN.plus;
  return PLAN.free;
}

/* =========================
   Tables and helpers
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

async function loadMonthlyUsage({ userId, month, model }) {
  const { data, error } = await supabaseAdmin
    .from(TABLES.usageMonthly)
    .select("input_tokens, output_tokens")
    .match(usageKey(userId, month, model))
    .maybeSingle();

  if (error) throw new Error(`Load ai_usage_monthly failed: ${error.message}`);

  const input = Number(data?.input_tokens || 0);
  const output = Number(data?.output_tokens || 0);
  const used = input + output;

  return { input, output, used };
}

async function bumpMonthlyUsage({ userId, month, model, addInput, addOutput }) {
  const current = await loadMonthlyUsage({ userId, month, model });

  const nextIn = current.input + Math.max(0, Number(addInput || 0));
  const nextOut = current.output + Math.max(0, Number(addOutput || 0));

  const { error } = await supabaseAdmin
    .from(TABLES.usageMonthly)
    .upsert({
      user_id: userId,
      month,
      model,
      input_tokens: nextIn,
      output_tokens: nextOut,
      updated_at: nowISO(),
    });

  if (error) throw new Error(`Upsert ai_usage_monthly failed: ${error.message}`);

  return { nextIn, nextOut, usedAfter: nextIn + nextOut };
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

  const { error } = await supabaseAdmin
    .from(TABLES.attachmentsMonthly)
    .upsert({
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

  const { error } = await supabaseAdmin
    .from(TABLES.imageMonthly)
    .upsert({
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
  if (current >= maxPerMinute) {
    return { ok: false, bucket, count: current };
  }

  const next = current + 1;

  const { error: upErr } = await supabaseAdmin
    .from(TABLES.throttleMinute)
    .upsert({
      user_id: userId,
      minute_bucket: bucket,
      count: next,
      updated_at: nowISO(),
    });

  if (upErr) throw new Error(`Upsert ai_throttle_minute failed: ${upErr.message}`);

  return { ok: true, bucket, count: next };
}

/* =========================
   Token accounting
   ========================= */

function getMonthlyLimitForModel(role, model) {
  const p = planForRole(role);
  if (role === "admin") return Infinity;
  const limit = Number(p.tokenLimits?.[model] || 0);
  return limit;
}

function canUseChatModel(role, model) {
  if (role === "admin") return true;
  if (role === "free") return model === "gpt-4o-mini";
  return model === "gpt-4o-mini" || model === "gpt-5-mini";
}

function chooseDefaultChatModel(role) {
  if (role === "free") return MODELS.CHAT_FALLBACK_FREE;
  return MODELS.CHAT_DEFAULT_PAID;
}

function safeBase64DataUrl(mime, base64) {
  const m = String(mime || "").toLowerCase().trim();
  const b = String(base64 || "").trim();

  if (!b) return null;
  if (!m) return null;

  if (!/^[a-z0-9]+\/[a-z0-9.+-]+$/.test(m)) return null;
  if (b.length > 18_000_000) return null;

  return `data:${m};base64,${b}`;
}

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
    const err = new Error(msg);
    err.status = resp.status;
    err.payload = data;
    throw err;
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
   Attachments + Vision budget logic
   ========================= */

function hasAnyAttachment(attachments) {
  return Array.isArray(attachments) && attachments.length > 0;
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

function tutorInstructions() {
  return [
    "You are a professional GCSE tutor.",
    "Give clear, exam-style answers.",
    "No markdown symbols. No LaTeX.",
    "Write chemical formulas using Unicode subscripts like CO₂.",
    "Keep answers concise unless the user asks for detailed.",
  ].join(" ");
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

async function canFreeUserUpload({ userId, month }) {
  const { count } = await loadUploadsCount({ userId, month });
  return count < PLAN.free.freeUploadsPerMonth;
}

async function recordFreeUpload({ userId, month, inc }) {
  await bumpUploadsCount({ userId, month, inc });
}

async function loadModelBudgetRemaining({ userId, role, month, model }) {
  if (role === "admin") return { used: 0, limit: Infinity, remaining: Infinity };

  const limit = getMonthlyLimitForModel(role, model);
  const usage = await loadMonthlyUsage({ userId, month, model });
  const remaining = Math.max(0, limit - usage.used);
  return { used: usage.used, limit, remaining };
}

async function requireTokensOrUpgrade({ userId, role, month, model, expectedMaxSpend }) {
  if (role === "admin") return { ok: true, remaining: Infinity };

  const { remaining, limit } = await loadModelBudgetRemaining({ userId, role, month, model });
  if (limit <= 0) return { ok: false, remaining, reason: "model-not-in-plan" };

  if (remaining <= 0) return { ok: false, remaining, reason: "out" };

  if (typeof expectedMaxSpend === "number" && expectedMaxSpend > 0) {
    if (remaining < expectedMaxSpend) return { ok: false, remaining, reason: "insufficient" };
  }

  return { ok: true, remaining };
}

async function chooseVisionModelForRequest({ userId, role, month, attachmentsPresent }) {
  if (!attachmentsPresent) {
    return { model: null, reason: "no-attachments" };
  }

  if (role === "admin") {
    return { model: MODELS.VISION_PREFERRED, reason: "admin" };
  }

  if (role !== "plus" && role !== "pro") {
    return { model: null, reason: "not-paid" };
  }

  // Vision budget is tracked under model bucket "gpt-5.1"
  const visionLimit = planForRole(role).visionBudget;
  const used = (await loadMonthlyUsage({ userId, month, model: MODELS.VISION_PREFERRED })).used;
  const remaining = Math.max(0, Number(visionLimit) - Number(used));

  if (remaining > 0) {
    return { model: MODELS.VISION_PREFERRED, reason: "vision-budget", remaining };
  }

  // fallback: use normal paid chat model once vision budget exhausted
  return { model: chooseDefaultChatModel(role), reason: "fallback" };
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
    const role = settings.role;

    const p = planForRole(role);

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

      // monthly image quota
      if (role !== "admin") {
        const limit = Number(p.dalle2PerMonth || 0);
        const { count } = await loadMonthlyImageCount({ userId, month, model: imageModel });

        if (!(limit === Infinity) && count >= limit) {
          return tooMany(
            res,
            "You have reached your monthly image generation limit. Please upgrade your plan."
          );
        }
      }

      // spam filter for image generation: additional hard gate
      const perMinuteHard = role === "pro" ? 8 : 4;
      if (throttle.count > perMinuteHard) {
        return tooMany(res, "Too many image requests too quickly. Please wait a minute.");
      }

      const result = await openaiDalle2Generate({ prompt, size });
      if (!result.url) return json(res, 500, { error: "Image generated but no URL returned." });

      if (role !== "admin") {
        await bumpMonthlyImageCount({ userId, month, model: imageModel, inc: 1 });
      }

      return json(res, 200, {
        image_url: result.url,
        model: imageModel,
        size,
        month,
        remaining_images:
          role === "admin"
            ? "Unlimited"
            : Math.max(0, Number(p.dalle2PerMonth) - (await loadMonthlyImageCount({ userId, month, model: imageModel })).count),
      });
    }

    // ========= CHAT =========
    const question = safeString(body.question || body.topic) || "";
    if (!question) return badRequest(res, "No question provided");

    const requestedModel = safeString(body.model) || "";
    const history = sanitizeHistory(body.history);

    const attachments = parseAttachments(body.attachments);
    const attachmentsPresent = hasAnyAttachment(attachments);

    // Attachments policy:
    // - plus/pro/admin: allowed
    // - free: allowed up to 5 per month, then block with upgrade message
    if (attachmentsPresent) {
      if (!p.allowUploads) {
        return forbidden(res, upgradeFeatureMessage());
      }

      if (role === "free") {
        const ok = await canFreeUserUpload({ userId, month });
        if (!ok) {
          return forbidden(
            res,
            "You have used your 5 free uploads for this month. Please upgrade to Plus or Pro: subscriptions.html"
          );
        }
      }
    }

    // Determine model selection
    let model = chooseDefaultChatModel(role);

    if (requestedModel) {
      if (!canUseChatModel(role, requestedModel)) {
        return forbidden(res, "Your plan can’t use that model.");
      }
      model = requestedModel;
    }

    // Vision model selection if attachments include pdf/images and user is plus/pro/admin
    let visionChosen = null;
    if (attachmentsPresent) {
      const v = await chooseVisionModelForRequest({ userId, role, month, attachmentsPresent: true });
      if (v.model) {
        visionChosen = v.model;
        model = v.model;
      } else {
        // free user can still upload limited times; use free model to read
        model = MODELS.CHAT_FALLBACK_FREE;
      }
    }

    // Output caps
    let maxOutputTokens = 450;
    if (isDetailedPrompt(question)) maxOutputTokens = 900;

    // Pre-check token budget for the selected model bucket
    // We reserve at least maxOutputTokens so user doesn't start a reply they can't finish.
    if (role !== "admin") {
      const pre = await requireTokensOrUpgrade({
        userId,
        role,
        month,
        model,
        expectedMaxSpend: maxOutputTokens,
      });

      if (!pre.ok) {
        return tooMany(res, upgradeHtmlMessage());
      }
    }

    // Build content array (attachments + question)
    let content;
    try {
      content = buildContentWithAttachments(question, attachments);
    } catch (e) {
      return badRequest(res, e.message || "Bad attachment");
    }

    // Build input payload
    const inputPayload = [
      ...history,
      {
        role: "user",
        content,
      },
    ];

    // Call OpenAI
    const data = await openaiResponsesCall({
      model,
      input: inputPayload,
      maxOutputTokens,
      temperature: 0.7,
    });

    const reply = extractOutputText(data) || "No response generated.";
    const usage = getUsageTokens(data);

    // Bump monthly usage for the actual model used
    if (role !== "admin") {
      await bumpMonthlyUsage({
        userId,
        month,
        model,
        addInput: usage.input,
        addOutput: usage.output,
      });
    }

    // If free user used attachments, record upload usage count after success
    if (attachmentsPresent && role === "free") {
      await recordFreeUpload({ userId, month, inc: 1 });
    }

    // Remaining tokens per relevant plan buckets
    const limits = {
      "gpt-4o-mini": getMonthlyLimitForModel(role, "gpt-4o-mini"),
      "gpt-5-mini": getMonthlyLimitForModel(role, "gpt-5-mini"),
      "gpt-5.1": role === "plus" ? PLAN.plus.visionBudget : role === "pro" ? PLAN.pro.visionBudget : 0,
    };

    async function remainingFor(m) {
      if (role === "admin") return Infinity;
      if (m === "gpt-5.1") {
        const used = (await loadMonthlyUsage({ userId, month, model: "gpt-5.1" })).used;
        const lim = Number(limits["gpt-5.1"] || 0);
        return Math.max(0, lim - used);
      }
      const lim = Number(limits[m] || 0);
      const used = (await loadMonthlyUsage({ userId, month, model: m })).used;
      return Math.max(0, lim - used);
    }

    const remaining = {
      "gpt-4o-mini": role === "admin" ? "Unlimited" : await remainingFor("gpt-4o-mini"),
      "gpt-5-mini": role === "admin" ? "Unlimited" : await remainingFor("gpt-5-mini"),
      "gpt-5.1": role === "admin" ? "Unlimited" : await remainingFor("gpt-5.1"),
    };

    // Response
    return json(res, 200, {
      reply,
      role,
      month,
      model_used: model,
      vision_used: Boolean(visionChosen && visionChosen === "gpt-5.1"),
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        total_tokens: usage.total,
      },
      plan_limits: limits,
      remaining_tokens: remaining,
      upgrade_url: "subscriptions.html",
      attachments: {
        submitted: attachments.length,
        free_monthly_allowance: role === "free" ? PLAN.free.freeUploadsPerMonth : "Unlimited",
        free_used_this_month:
          role === "free" ? (await loadUploadsCount({ userId, month })).count : undefined,
      },
    });
  } catch (error) {
    console.error("Server error:", error);
    return json(res, 500, { error: "Server error" });
  }
};