// /api/ai.js
// ReviseFlow unified AI endpoint
// Chat + attachments + image generation + usage tracking + throttling

const { createClient } = require("@supabase/supabase-js");

/* =========================
   Environment
   ========================= */

function mustEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing env var: ${name}`);
  }
  return String(value).trim();
}

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = mustEnv("OPENAI_API_KEY");
const ALLOW_DEBUG = String(process.env.ALLOW_DEBUG || "").toLowerCase() === "true";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* =========================
   Constants
   ========================= */

const MODELS = {
  CHAT_FREE: "gpt-4o-mini",
  CHAT_PAID: "gpt-5-mini",
  VISION: "gpt-5.1",
  IMAGE: "dall-e-2",
};

const PLANS = {
  free: {
    allowUploads: true,
    allowImages: false,
    freeUploadsPerMonth: 5,
    imageGenerationsPerMonth: 0,
    throttlePerMinute: 10,
    tokenLimits: {
      "gpt-4o-mini": 300_000,
      "gpt-5-mini": 0,
      "gpt-5.1": 0,
    },
  },
  plus: {
    allowUploads: true,
    allowImages: true,
    freeUploadsPerMonth: Infinity,
    imageGenerationsPerMonth: 20,
    throttlePerMinute: 20,
    tokenLimits: {
      "gpt-4o-mini": 1_000_000,
      "gpt-5-mini": 1_000_000,
      "gpt-5.1": 1_000_000,
    },
  },
  pro: {
    allowUploads: true,
    allowImages: true,
    freeUploadsPerMonth: Infinity,
    imageGenerationsPerMonth: 50,
    throttlePerMinute: 40,
    tokenLimits: {
      "gpt-4o-mini": 3_000_000,
      "gpt-5-mini": 3_000_000,
      "gpt-5.1": 3_000_000,
    },
  },
  admin: {
    allowUploads: true,
    allowImages: true,
    freeUploadsPerMonth: Infinity,
    imageGenerationsPerMonth: Infinity,
    throttlePerMinute: 999,
    tokenLimits: {
      "gpt-4o-mini": Infinity,
      "gpt-5-mini": Infinity,
      "gpt-5.1": Infinity,
    },
  },
};

const TABLES = {
  usageMonthly: "ai_usage_monthly",
  uploadsMonthly: "ai_attachments_monthly",
  imageMonthly: "image_usage_monthly",
  throttleMinute: "ai_throttle_minute",
};

const MAX_ATTACHMENTS = 3;
const MAX_BASE64_LENGTH = 18_000_000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 6000;

/* =========================
   Helpers
   ========================= */

function json(res, status, data) {
  return res.status(status).json(data);
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

function normalizeTier(input) {
  const t = String(input || "free").toLowerCase().trim();
  if (t === "free" || t === "plus" || t === "pro" || t === "admin") return t;
  if (t === "user" || t === "basic") return "free";
  if (t === "premium") return "plus";
  return "free";
}

function planForTier(tier) {
  return PLANS[tier] || PLANS.free;
}

function chooseDefaultChatModel(tier) {
  return tier === "free" ? MODELS.CHAT_FREE : MODELS.CHAT_PAID;
}

function canUseModel(tier, model) {
  if (tier === "admin") return true;
  const plan = planForTier(tier);
  const limit = Number(plan.tokenLimits?.[model] || 0);
  return limit > 0 || limit === Infinity;
}

function getModelLimitForTier(tier, model) {
  if (tier === "admin") return Infinity;
  return Number(planForTier(tier).tokenLimits?.[model] || 0);
}

function detailedPrompt(question) {
  return /(^|\b)(detailed|in detail|step[- ]by[- ]step|full marks|long answer|thoroughly)(\b|$)/i.test(
    String(question || "")
  );
}

function maxOutputTokensForQuestion(question) {
  return detailedPrompt(question) ? 900 : 450;
}

function isValidMime(mime) {
  return /^[a-z0-9]+\/[a-z0-9.+-]+$/i.test(String(mime || "").trim());
}

function makeDataUrl(mime, base64) {
  const cleanMime = String(mime || "").trim().toLowerCase();
  const cleanBase64 = String(base64 || "").trim();
  if (!cleanMime || !cleanBase64) return null;
  if (!isValidMime(cleanMime)) return null;
  if (cleanBase64.length > MAX_BASE64_LENGTH) return null;
  return `data:${cleanMime};base64,${cleanBase64}`;
}

function upgradeUsageMessage() {
  return "You have run out of AI usage for this month. Please upgrade in subscriptions.html to continue.";
}

function upgradeFeatureMessage() {
  return "This feature requires Plus or Pro. Please upgrade in subscriptions.html.";
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

function parseAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments)) return [];

  const out = [];

  for (const item of rawAttachments) {
    if (!isObject(item)) continue;

    const kind = String(item.kind || "").toLowerCase().trim();
    const filename =
      safeString(item.filename) ||
      (kind === "pdf" ? "document.pdf" : kind === "image" ? "image.png" : "attachment");
    const mime =
      safeString(item.mime) ||
      (kind === "pdf" ? "application/pdf" : kind === "image" ? "image/png" : null);
    const base64 = safeString(item.base64);

    if (!base64) continue;
    if (kind !== "pdf" && kind !== "image") continue;
    if (!mime || !isValidMime(mime)) continue;

    out.push({
      kind,
      filename,
      mime,
      base64,
    });

    if (out.length >= MAX_ATTACHMENTS) break;
  }

  return out;
}

function buildUserContent(question, attachments) {
  const content = [];

  for (const attachment of attachments) {
    if (attachment.kind === "pdf") {
      const dataUrl = makeDataUrl(attachment.mime, attachment.base64);
      if (!dataUrl) {
        throw new Error(`Invalid PDF attachment: ${attachment.filename}`);
      }

      content.push({
        type: "input_file",
        filename: attachment.filename,
        file_data: dataUrl,
      });
      continue;
    }

    if (attachment.kind === "image") {
      const dataUrl = makeDataUrl(attachment.mime, attachment.base64);
      if (!dataUrl) {
        throw new Error(`Invalid image attachment: ${attachment.filename}`);
      }

      content.push({
        type: "input_image",
        image_url: dataUrl,
      });
    }
  }

  content.push({
    type: "input_text",
    text: String(question || ""),
  });

  return content;
}

function extractOutputText(resp) {
  if (safeString(resp?.output_text)) return resp.output_text;

  if (Array.isArray(resp?.output)) {
    for (const item of resp.output) {
      if (!Array.isArray(item?.content)) continue;
      for (const c of item.content) {
        if (c?.type === "output_text" && safeString(c?.text)) {
          return c.text;
        }
      }
    }
  }

  return "";
}

function usageFromResponse(resp) {
  const u = resp?.usage || {};
  const input = Number(u.input_tokens || 0);
  const output = Number(u.output_tokens || 0);
  return {
    input,
    output,
    total: input + output,
  };
}

/* =========================
   Auth
   ========================= */

function extractBearerToken(req) {
  const auth = safeString(req.headers.authorization) || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return safeString(auth.slice(7)) || null;
}

function extractBackupToken(req, body) {
  const h1 = safeString(req.headers["x-access-token"]);
  const h2 = safeString(req.headers["x-supabase-token"]);
  const b1 = isObject(body) ? safeString(body.access_token) : null;
  return h1 || h2 || b1 || null;
}

async function getAuthUser(req, body) {
  const token = extractBearerToken(req) || extractBackupToken(req, body);
  if (!token) return { error: "Missing auth token" };

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) {
    return { error: "Invalid session" };
  }

  return {
    user: data.user,
    accessToken: token,
  };
}

/* =========================
   User settings
   ========================= */

async function ensureUserSettingsRow(userId) {
  const existing = await supabaseAdmin
    .from("user_settings")
    .select("user_id,tier,timezone")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) {
    return { row: null, error: existing.error };
  }

  if (existing.data) {
    return { row: existing.data, error: null };
  }

  const inserted = await supabaseAdmin
    .from("user_settings")
    .insert({
      user_id: userId,
      tier: "free",
    })
    .select("user_id,tier,timezone")
    .maybeSingle();

  if (inserted.error) {
    return { row: null, error: inserted.error };
  }

  return { row: inserted.data, error: null };
}

async function getUserSettings(userId) {
  const { row, error } = await ensureUserSettingsRow(userId);

  if (error) {
    console.error("user_settings read error:", error);
    return {
      tier: "free",
      timezone: "UTC",
      _settingsError: error.message || String(error),
    };
  }

  return {
    tier: normalizeTier(row?.tier),
    timezone: safeString(row?.timezone) || "UTC",
  };
}

/* =========================
   Usage + limits
   ========================= */

async function loadMonthlyUsage({ userId, month, model }) {
  const { data, error } = await supabaseAdmin
    .from(TABLES.usageMonthly)
    .select("input_tokens,output_tokens")
    .eq("user_id", userId)
    .eq("month", month)
    .eq("model", model)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read ${TABLES.usageMonthly}: ${error.message}`);
  }

  const input = Number(data?.input_tokens || 0);
  const output = Number(data?.output_tokens || 0);

  return {
    input,
    output,
    used: input + output,
  };
}

async function bumpMonthlyUsage({ userId, month, model, addInput, addOutput }) {
  const current = await loadMonthlyUsage({ userId, month, model });

  const nextInput = current.input + Math.max(0, Number(addInput || 0));
  const nextOutput = current.output + Math.max(0, Number(addOutput || 0));

  const { error } = await supabaseAdmin.from(TABLES.usageMonthly).upsert({
    user_id: userId,
    month,
    model,
    input_tokens: nextInput,
    output_tokens: nextOutput,
    updated_at: nowISO(),
  });

  if (error) {
    throw new Error(`Failed to upsert ${TABLES.usageMonthly}: ${error.message}`);
  }

  return {
    usedAfter: nextInput + nextOutput,
  };
}

async function loadMonthlyUploadCount({ userId, month }) {
  const { data, error } = await supabaseAdmin
    .from(TABLES.uploadsMonthly)
    .select("uploads_count")
    .eq("user_id", userId)
    .eq("month", month)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read ${TABLES.uploadsMonthly}: ${error.message}`);
  }

  return {
    count: Number(data?.uploads_count || 0),
  };
}

async function bumpMonthlyUploadCount({ userId, month, inc = 1 }) {
  const current = await loadMonthlyUploadCount({ userId, month });
  const next = current.count + Math.max(0, Number(inc || 0));

  const { error } = await supabaseAdmin.from(TABLES.uploadsMonthly).upsert({
    user_id: userId,
    month,
    uploads_count: next,
    updated_at: nowISO(),
  });

  if (error) {
    throw new Error(`Failed to upsert ${TABLES.uploadsMonthly}: ${error.message}`);
  }

  return {
    countAfter: next,
  };
}

async function loadMonthlyImageCount({ userId, month, model }) {
  const { data, error } = await supabaseAdmin
    .from(TABLES.imageMonthly)
    .select("count")
    .eq("user_id", userId)
    .eq("month", month)
    .eq("model", model)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read ${TABLES.imageMonthly}: ${error.message}`);
  }

  return {
    count: Number(data?.count || 0),
  };
}

async function bumpMonthlyImageCount({ userId, month, model, inc = 1 }) {
  const current = await loadMonthlyImageCount({ userId, month, model });
  const next = current.count + Math.max(0, Number(inc || 0));

  const { error } = await supabaseAdmin.from(TABLES.imageMonthly).upsert({
    user_id: userId,
    month,
    model,
    count: next,
    updated_at: nowISO(),
  });

  if (error) {
    throw new Error(`Failed to upsert ${TABLES.imageMonthly}: ${error.message}`);
  }

  return {
    countAfter: next,
  };
}

async function throttleCheckAndBump({ userId, maxPerMinute }) {
  const bucket = minuteBucketUTC();

  const { data, error } = await supabaseAdmin
    .from(TABLES.throttleMinute)
    .select("count")
    .eq("user_id", userId)
    .eq("minute_bucket", bucket)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read ${TABLES.throttleMinute}: ${error.message}`);
  }

  const current = Number(data?.count || 0);

  if (current >= maxPerMinute) {
    return {
      ok: false,
      bucket,
      count: current,
    };
  }

  const next = current + 1;

  const { error: upsertError } = await supabaseAdmin.from(TABLES.throttleMinute).upsert({
    user_id: userId,
    minute_bucket: bucket,
    count: next,
    updated_at: nowISO(),
  });

  if (upsertError) {
    throw new Error(`Failed to upsert ${TABLES.throttleMinute}: ${upsertError.message}`);
  }

  return {
    ok: true,
    bucket,
    count: next,
  };
}

async function checkMonthlyTokenAllowance({ userId, tier, month, model, expectedMaxSpend }) {
  if (tier === "admin") {
    return { ok: true, remaining: Infinity, used: 0, limit: Infinity };
  }

  const limit = getModelLimitForTier(tier, model);
  const usage = await loadMonthlyUsage({ userId, month, model });
  const remaining = Math.max(0, limit - usage.used);

  if (limit <= 0) {
    return {
      ok: false,
      reason: "model-not-in-plan",
      used: usage.used,
      remaining: 0,
      limit,
    };
  }

  if (remaining <= 0) {
    return {
      ok: false,
      reason: "out-of-usage",
      used: usage.used,
      remaining,
      limit,
    };
  }

  if (typeof expectedMaxSpend === "number" && remaining < expectedMaxSpend) {
    return {
      ok: false,
      reason: "insufficient-remaining-budget",
      used: usage.used,
      remaining,
      limit,
    };
  }

  return {
    ok: true,
    used: usage.used,
    remaining,
    limit,
  };
}

/* =========================
   OpenAI
   ========================= */

async function openAIResponses({ model, input, maxOutputTokens, temperature = 0.7 }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens: maxOutputTokens,
      temperature,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenAI Responses request failed");
  }

  return data;
}

async function openAIImageGeneration({ prompt, size = "1024x1024" }) {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODELS.IMAGE,
      prompt,
      size,
      response_format: "url",
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenAI Images request failed");
  }

  return {
    url: data?.data?.[0]?.url || null,
  };
}

/* =========================
   Model routing
   ========================= */

async function chooseModelForRequest({ tier, requestedModel, attachmentsPresent }) {
  if (attachmentsPresent) {
    if (tier === "free") {
      return {
        model: MODELS.CHAT_FREE,
        usedVision: false,
        reason: "free-attachments-fallback",
      };
    }

    return {
      model: MODELS.VISION,
      usedVision: true,
      reason: "attachments-vision",
    };
  }

  if (requestedModel && canUseModel(tier, requestedModel)) {
    return {
      model: requestedModel,
      usedVision: false,
      reason: "requested-model",
    };
  }

  return {
    model: chooseDefaultChatModel(tier),
    usedVision: false,
    reason: "default-chat",
  };
}

async function buildRemainingTokens(userId, tier, month) {
  if (tier === "admin") {
    return {
      "gpt-4o-mini": "Unlimited",
      "gpt-5-mini": "Unlimited",
      "gpt-5.1": "Unlimited",
    };
  }

  const modelNames = ["gpt-4o-mini", "gpt-5-mini", "gpt-5.1"];
  const result = {};

  for (const model of modelNames) {
    const limit = getModelLimitForTier(tier, model);
    if (limit <= 0) {
      result[model] = 0;
      continue;
    }

    const usage = await loadMonthlyUsage({ userId, month, model });
    result[model] = Math.max(0, limit - usage.used);
  }

  return result;
}

/* =========================
   Handler
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

    const throttle = await throttleCheckAndBump({
      userId,
      maxPerMinute: plan.throttlePerMinute,
    });

    if (!throttle.ok) {
      return json(res, 429, {
        error: "Too many requests. Please wait a moment and try again.",
      });
    }

    const action = String(body.action || "chat").toLowerCase().trim();

    /* =========================
       IMAGE GENERATION
       ========================= */
    if (action === "image") {
      if (!plan.allowImages) {
        return json(res, 403, {
          error: upgradeFeatureMessage(),
          ...(wantsDebug && (ALLOW_DEBUG || tier === "admin") ? { debug: { tier } } : {}),
        });
      }

      const prompt = safeString(body.prompt);
      if (!prompt) {
        return json(res, 400, { error: "No prompt provided" });
      }

      if (tier !== "admin") {
        const imageUsage = await loadMonthlyImageCount({
          userId,
          month,
          model: MODELS.IMAGE,
        });

        const imageLimit = Number(plan.imageGenerationsPerMonth || 0);
        if (imageUsage.count >= imageLimit) {
          return json(res, 429, {
            error: "You have reached your monthly image generation limit.",
          });
        }
      }

      const result = await openAIImageGeneration({
        prompt,
        size: "1024x1024",
      });

      if (!result.url) {
        return json(res, 500, {
          error: "Image generated but no URL returned.",
        });
      }

      if (tier !== "admin") {
        await bumpMonthlyImageCount({
          userId,
          month,
          model: MODELS.IMAGE,
          inc: 1,
        });
      }

      const imageCount = await loadMonthlyImageCount({
        userId,
        month,
        model: MODELS.IMAGE,
      });

      return json(res, 200, {
        image_url: result.url,
        model: MODELS.IMAGE,
        tier,
        month,
        remaining_images:
          tier === "admin"
            ? "Unlimited"
            : Math.max(0, Number(plan.imageGenerationsPerMonth) - Number(imageCount.count)),
        ...(wantsDebug && (ALLOW_DEBUG || tier === "admin")
          ? {
              debug: {
                userId,
                throttle,
                settings,
              },
            }
          : {}),
      });
    }

    /* =========================
       CHAT / FILE READING
       ========================= */
    const question = safeString(body.question || body.topic);
    if (!question) {
      return json(res, 400, { error: "No question provided" });
    }

    const history = sanitizeHistory(body.history);
    const attachments = parseAttachments(body.attachments);
    const attachmentsPresent = attachments.length > 0;
    const requestedModel = safeString(body.model);

    if (attachmentsPresent) {
      if (!plan.allowUploads) {
        return json(res, 403, {
          error: upgradeFeatureMessage(),
        });
      }

      if (tier === "free") {
        const currentUploads = await loadMonthlyUploadCount({ userId, month });
        if (currentUploads.count >= plan.freeUploadsPerMonth) {
          return json(res, 403, {
            error: "You have used your 5 free uploads for this month. Please upgrade in subscriptions.html.",
          });
        }
      }
    }

    const routing = await chooseModelForRequest({
      tier,
      requestedModel,
      attachmentsPresent,
    });

    let model = routing.model;

    if (!canUseModel(tier, model) && model !== MODELS.VISION) {
      model = chooseDefaultChatModel(tier);
    }

    const maxOutputTokens = maxOutputTokensForQuestion(question);

    const allowance = await checkMonthlyTokenAllowance({
      userId,
      tier,
      month,
      model,
      expectedMaxSpend: maxOutputTokens,
    });

    if (!allowance.ok) {
      return json(res, 429, {
        error: upgradeUsageMessage(),
        ...(wantsDebug && (ALLOW_DEBUG || tier === "admin")
          ? {
              debug: {
                allowance,
                model,
                tier,
              },
            }
          : {}),
      });
    }

    let userContent;
    try {
      userContent = buildUserContent(question, attachments);
    } catch (attachmentError) {
      return json(res, 400, {
        error: attachmentError.message || "Invalid attachment",
      });
    }

    const inputPayload = [
      ...history,
      {
        role: "user",
        content: userContent,
      },
    ];

    const aiResponse = await openAIResponses({
      model,
      input: inputPayload,
      maxOutputTokens,
      temperature: 0.7,
    });

    const reply = extractOutputText(aiResponse) || "No response generated.";
    const usage = usageFromResponse(aiResponse);

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
      await bumpMonthlyUploadCount({
        userId,
        month,
        inc: 1,
      });
    }

    const remainingTokens = await buildRemainingTokens(userId, tier, month);

    return json(res, 200, {
      reply,
      tier,
      month,
      model_used: model,
      vision_used: routing.usedVision,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        total_tokens: usage.total,
      },
      remaining_tokens: remainingTokens,
      upgrade_url: "subscriptions.html",
      attachments: {
        submitted: attachments.length,
        free_monthly_allowance: tier === "free" ? plan.freeUploadsPerMonth : "Unlimited",
        free_used_this_month:
          tier === "free" ? (await loadMonthlyUploadCount({ userId, month })).count : undefined,
      },
      ...(wantsDebug && (ALLOW_DEBUG || tier === "admin")
        ? {
            debug: {
              userId,
              tier,
              settings,
              routing,
              throttle,
              authHint: "Use Authorization: Bearer <token>",
            },
          }
        : {}),
    });
  } catch (error) {
    console.error("AI endpoint server error:", error);
    return json(res, 500, {
      error: "Server error",
      detail: String(error?.message || error),
    });
  }
};