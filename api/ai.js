// /api/ai.js
// ReviseFlow unified AI endpoint: chat + DALL·E image generation

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function todayInTimezone(tz) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(new Date()); // YYYY-MM-DD
}

function monthInTimezone(tz) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  });
  const parts = dtf.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value || "1970";
  const m = parts.find((p) => p.type === "month")?.value || "01";
  return `${y}-${m}`; // YYYY-MM
}

function json(res, code, obj) {
  return res.status(code).json(obj);
}

function normalizeRole(role) {
  const r = String(role || "free").toLowerCase().trim();
  if (["admin", "pro", "plus", "free", "user"].includes(r)) {
    return r === "user" ? "free" : r;
  }
  return "free";
}

function clampInt(n, a, b) {
  n = Number.isFinite(Number(n)) ? Number(n) : a;
  return Math.max(a, Math.min(b, n));
}

function isDetailedPrompt(text) {
  return /(^|\b)(detailed|in detail|step[- ]by[- ]step|full marks)(\b|$)/i.test(String(text || ""));
}

// Try to count ONLY text tokens if the API provides breakdowns.
// Otherwise fall back to total tokens.
function getTextTokenCountsFromUsage(usage) {
  // Different docs/events sometimes say input_token_details vs input_tokens_details.
  const inDet = usage?.input_token_details || usage?.input_tokens_details || {};
  const outDet = usage?.output_token_details || usage?.output_tokens_details || {};

  const inputText = Number(inDet?.text_tokens);
  const outputText = Number(outDet?.text_tokens);

  const hasTextBreakdown =
    Number.isFinite(inputText) || Number.isFinite(outputText);

  if (hasTextBreakdown) {
    return {
      inputTextTokens: Number.isFinite(inputText) ? inputText : 0,
      outputTextTokens: Number.isFinite(outputText) ? outputText : 0,
      usedFallbackTotals: false,
    };
  }

  return {
    inputTextTokens: Number(usage?.input_tokens || 0),
    outputTextTokens: Number(usage?.output_tokens || 0),
    usedFallbackTotals: true,
  };
}

function safeBase64DataUrl(mime, base64) {
  const m = String(mime || "").toLowerCase().trim();
  const b = String(base64 || "").trim();

  if (!b) return null;
  if (!m) return null;

  // Very light validation
  if (!/^[a-z0-9]+\/[a-z0-9.+-]+$/.test(m)) return null;
  // don’t allow gigantic payloads (basic protection)
  if (b.length > 18_000_000) return null; // ~13.5MB base64-ish

  return `data:${m};base64,${b}`;
}

async function getAuthUser(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return { error: "Missing auth token" };

  const accessToken = authHeader.slice(7).trim();
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(accessToken);

  if (userErr || !userData?.user) return { error: "Invalid session" };
  return { user: userData.user, accessToken };
}

async function getUserSettings(userId) {
  const { data: settings, error } = await supabaseAdmin
    .from("user_settings")
    .select("role, timezone")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    // Don’t hard-fail if settings row doesn’t exist
    return { role: "free", timezone: "UTC" };
  }
  return {
    role: normalizeRole(settings?.role),
    timezone: settings?.timezone || "UTC",
  };
}

// ---------- QUOTAS ----------
const TOKEN_LIMITS = {
  free: {
    period: "daily",
    models: {
      "gpt-4o-mini": 6000,
    },
  },
  plus: {
    period: "monthly",
    models: {
      "gpt-5-mini": 1_000_000,
      "gpt-4o-mini": 2_000_000,
    },
  },
  pro: {
    period: "monthly",
    models: {
      "gpt-5-mini": 3_000_000,
      "gpt-4o-mini": 2_000_000,
    },
  },
  admin: {
    period: "none",
    models: {},
  },
};

const IMAGE_LIMITS = {
  free: { "dall-e-2": 0, "dall-e-3": 0 },
  plus: { "dall-e-2": 1, "dall-e-3": 0 },
  pro: { "dall-e-2": 4, "dall-e-3": 2 },
  admin: { "dall-e-2": Infinity, "dall-e-3": Infinity },
};

function allowedChatModelsForRole(role) {
  if (role === "admin" || role === "pro" || role === "plus") {
    return new Set(["gpt-4o-mini", "gpt-5-mini"]);
  }
  return new Set(["gpt-4o-mini"]);
}

function ensureModelAllowed(role, model) {
  const allowed = allowedChatModelsForRole(role);
  if (!allowed.has(model)) return null;
  return model;
}

async function loadTokenUsage({ userId, role, tz, model }) {
  if (role === "admin") {
    return { used: 0, limit: Infinity, periodKey: null, table: null };
  }

  const plan = TOKEN_LIMITS[role] || TOKEN_LIMITS.free;
  const limit = Number(plan.models[model] || 0);

  if (plan.period === "daily") {
    const day = todayInTimezone(tz);
    const { data, error } = await supabaseAdmin
      .from("ai_usage_daily")
      .select("input_tokens, output_tokens")
      .eq("user_id", userId)
      .eq("day", day)
      .eq("model", model)
      .maybeSingle();

    if (error) throw new Error(`Load ai_usage_daily failed: ${error.message}`);

    const used = (data?.input_tokens || 0) + (data?.output_tokens || 0);
    return { used, limit, periodKey: day, table: "ai_usage_daily" };
  }

  const month = monthInTimezone(tz);
  const { data, error } = await supabaseAdmin
    .from("ai_usage_monthly")
    .select("input_tokens, output_tokens")
    .eq("user_id", userId)
    .eq("month", month)
    .eq("model", model)
    .maybeSingle();

  if (error) throw new Error(`Load ai_usage_monthly failed: ${error.message}`);

  const used = (data?.input_tokens || 0) + (data?.output_tokens || 0);
  return { used, limit, periodKey: month, table: "ai_usage_monthly" };
}

async function reserveTokenUsage({ userId, role, tz, model, reserveInput, reserveOutput }) {
  if (role === "admin") return { allowed: true, used: 0, limit: Infinity, reservation: { reserveInput: 0, reserveOutput: 0 } };

  const info = await loadTokenUsage({ userId, role, tz, model });
  if (info.limit <= 0) {
    return { allowed: false, used: info.used, limit: info.limit, reservation: { reserveInput: 0, reserveOutput: 0 } };
  }

  const addInput = Math.max(0, Number(reserveInput || 0));
  const addOutput = Math.max(0, Number(reserveOutput || 0));

  const { data, error } = await supabaseAdmin.rpc("consume_ai_tokens", {
    p_table: info.table,
    p_user_id: userId,
    p_period_key: info.periodKey,
    p_model: model,
    p_add_input: addInput,
    p_add_output: addOutput,
    p_limit: info.limit,
  });

  if (error) throw new Error(`consume_ai_tokens failed: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.allowed) return { allowed: false, used: info.used, limit: info.limit, reservation: { reserveInput: addInput, reserveOutput: addOutput } };

  return {
    allowed: true,
    used: Number(row.used || 0),
    limit: info.limit,
    table: info.table,
    periodKey: info.periodKey,
    reservation: { reserveInput: addInput, reserveOutput: addOutput },
  };
}

async function adjustTokenUsage({ role, table, userId, periodKey, model, deltaInput, deltaOutput }) {
  if (role === "admin") return;

  const { error } = await supabaseAdmin.rpc("adjust_ai_tokens", {
    p_table: table,
    p_user_id: userId,
    p_period_key: periodKey,
    p_model: model,
    p_delta_input: Number(deltaInput || 0),
    p_delta_output: Number(deltaOutput || 0),
  });

  if (error) throw new Error(`adjust_ai_tokens failed: ${error.message}`);
}

async function consumeImageQuota({ userId, tz, model, limit, inc = 1 }) {
  if (!Number.isFinite(limit)) return { allowed: true };

  const day = todayInTimezone(tz);
  const { data, error } = await supabaseAdmin.rpc("consume_image_quota", {
    p_user_id: userId,
    p_day: day,
    p_model: model,
    p_inc: Math.max(0, Number(inc || 0)),
    p_limit: Number(limit),
  });

  if (error) throw new Error(`consume_image_quota failed: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  return { allowed: !!row?.allowed, count: Number(row?.used || 0) };
}

function estimateInputTokens(question, history = []) {
  const q = String(question || "");
  const historyText = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => String(m.content || ""))
    .join("\n");

  const chars = q.length + historyText.length;
  return clampInt(Math.ceil(chars / 4), 80, 6000);
}

// ---------- OPENAI CALLS ----------
async function openaiResponses({ model, input, maxOutputTokens }) {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens: maxOutputTokens,
      temperature: 0.7,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || "OpenAI Responses request failed");
  }
  return data;
}

async function openaiDalleGenerate({ model, prompt, size }) {
  // DALL·E 2/3 supported via Images API :contentReference[oaicite:1]{index=1}
  const body = {
    model,
    prompt,
    size,
    // default response_format is url for dall-e-2/3
    response_format: "url",
  };

  // DALL·E 3 supports quality; user asked “standard”
  if (model === "dall-e-3") {
    body.quality = "standard";
  }

  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || "OpenAI Images request failed");
  }

  const url = data?.data?.[0]?.url || null;
  const revised = data?.data?.[0]?.revised_prompt || null;
  return { url, revised_prompt: revised };
}

// ---------- MAIN HANDLER ----------
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  let reservationContext = null;

  try {
    // --------- AUTH ----------
    const auth = await getAuthUser(req);
    if (auth.error) return json(res, 401, { error: auth.error });

    const userId = auth.user.id;

    // --------- SETTINGS ----------
    const settings = await getUserSettings(userId);
    const role = settings.role;
    const tz = (req.body?.timezone || settings.timezone || "UTC").trim();

    // --------- ROUTING ----------
    // action: "chat" (default) | "image"
    const action = String(req.body?.action || "chat").toLowerCase().trim();

    // =========================================================
    // IMAGE GENERATION (DALL·E)
    // =========================================================
    if (action === "image") {
      const prompt = String(req.body?.prompt || "").trim();
      const dalle = String(req.body?.model || "dall-e-2").trim();

      if (!prompt) return json(res, 400, { error: "No prompt provided" });

      const allowedModels = new Set(["dall-e-2", "dall-e-3"]);
      if (!allowedModels.has(dalle)) {
        return json(res, 400, { error: "Invalid image model (use dall-e-2 or dall-e-3)" });
      }

      const limits = IMAGE_LIMITS[role] || IMAGE_LIMITS.free;
      const limit = limits[dalle] ?? 0;

      if (role !== "admin") {
        const quota = await consumeImageQuota({ userId, tz, model: dalle, limit, inc: 1 });
        if (!quota.allowed) {
          return json(res, 429, {
            error:
              role === "plus"
                ? "Daily image limit reached (Plus: 1× DALL·E 2/day)."
                : "Daily image limit reached.",
          });
        }
      }

      // enforce your requested sizes
      const size = "1024x1024";

      const result = await openaiDalleGenerate({
        model: dalle,
        prompt,
        size,
      });

      if (!result.url) {
        return json(res, 500, { error: "Image generated but no URL returned." });
      }

      return json(res, 200, {
        image_url: result.url,
        revised_prompt: result.revised_prompt || undefined,
        model: dalle,
        size,
      });
    }

    // =========================================================
    // CHAT (GCSE tutor)
    // =========================================================
    const question = (req.body?.question || req.body?.topic || "").trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];

    // optional attachments: plus/pro/admin only
    // attachments: [{ kind:"pdf"|"image", filename, mime, base64 }]
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];

    if (!question) return json(res, 400, { error: "No question provided" });

    // model selection
    const requestedModel = String(req.body?.model || "").trim();
    const defaultModel = role === "plus" || role === "pro" || role === "admin" ? "gpt-5-mini" : "gpt-4o-mini";
    const model = ensureModelAllowed(role, requestedModel || defaultModel);

    if (!model) {
      return json(res, 403, { error: "Your plan can’t use that model." });
    }

    // attachments allowed?
    const canAttach = role === "plus" || role === "pro" || role === "admin";
    if (attachments.length > 0 && !canAttach) {
      return json(res, 403, { error: "File/image inputs are Plus/Pro/Admin only." });
    }

    // output caps
    let maxOutputTokens = 450;
    if (isDetailedPrompt(question)) maxOutputTokens = 900;

    const estimatedInputTokens = estimateInputTokens(question, history);
    let tokenReservation = { reservation: { reserveInput: 0, reserveOutput: 0 }, table: null, periodKey: null };

    if (role !== "admin") {
      let reserveAttempt = await reserveTokenUsage({
        userId,
        role,
        tz,
        model,
        reserveInput: estimatedInputTokens,
        reserveOutput: maxOutputTokens,
      });

      if (!reserveAttempt.allowed && maxOutputTokens === 900) {
        maxOutputTokens = 450;
        reserveAttempt = await reserveTokenUsage({
          userId,
          role,
          tz,
          model,
          reserveInput: estimatedInputTokens,
          reserveOutput: maxOutputTokens,
        });
      }

      if (!reserveAttempt.allowed) {
        if (Number(reserveAttempt.limit || 0) <= 0) {
          return json(res, 403, { error: "Your plan doesn’t include token usage for this model." });
        }
        return json(res, 429, { error: "Sorry, you have run out of AI usage for this period." });
      }

      tokenReservation = reserveAttempt;
      reservationContext = {
        role,
        table: tokenReservation.table,
        userId,
        periodKey: tokenReservation.periodKey,
        model,
        reservedInput: Number(tokenReservation.reservation?.reserveInput || 0),
        reservedOutput: Number(tokenReservation.reservation?.reserveOutput || 0),
      };
    }

    // Build Responses API input array
    const content = [];

    // Add attachments first (so the question references them)
    for (const a of attachments) {
      const kind = String(a?.kind || "").toLowerCase().trim();
      const filename = String(a?.filename || "").trim() || (kind === "pdf" ? "document.pdf" : "image.png");
      const mime = String(a?.mime || "").trim();
      const base64 = String(a?.base64 || "").trim();

      if (kind === "pdf") {
        const dataUrl = safeBase64DataUrl(mime || "application/pdf", base64);
        if (!dataUrl) return json(res, 400, { error: "Bad PDF attachment (mime/base64)." });

        content.push({
          type: "input_file",
          filename,
          file_data: dataUrl, // file inputs format :contentReference[oaicite:2]{index=2}
        });
      } else if (kind === "image") {
        const dataUrl = safeBase64DataUrl(mime || "image/png", base64);
        if (!dataUrl) return json(res, 400, { error: "Bad image attachment (mime/base64)." });

        content.push({
          type: "input_image",
          image_url: dataUrl,
        });
      } else {
        return json(res, 400, { error: "Attachment kind must be 'pdf' or 'image'." });
      }
    }

    // GCSE tutor system style
    const system = [
      "You are a professional GCSE tutor.",
      "Give clear, exam-style answers.",
      "No markdown symbols. No LaTeX.",
      "Write chemical formulas using Unicode subscripts like CO₂.",
      "Keep answers concise unless user asks for detailed.",
    ].join(" ");

    // History (simple pass-through; expect {role, content} with text)
    const safeHistory = history
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .slice(-12)
      .map((m) => ({
        role: m.role,
        content: [{ type: "input_text", text: String(m.content || "").slice(0, 6000) }],
      }));

    // The user’s question
    content.push({ type: "input_text", text: question });

    const inputPayload = [
      {
        role: "system",
        content: [{ type: "input_text", text: system }],
      },
      ...safeHistory,
      {
        role: "user",
        content,
      },
    ];

    // Call OpenAI
    const data = await openaiResponses({
      model,
      input: inputPayload,
      maxOutputTokens,
    });

    // Extract reply
    const reply =
      data?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text ||
      data?.output_text ||
      "No response generated.";

    const usage = data?.usage || {};
    const { inputTextTokens, outputTextTokens, usedFallbackTotals } = getTextTokenCountsFromUsage(usage);

    // If there were attachments, do NOT count their tokens.
    // We attempt to count text-only tokens; if we had to fallback to totals, we still count totals (safer).
    const shouldExcludeAttachmentTokens = attachments.length > 0 && !usedFallbackTotals;
    const countedInput = shouldExcludeAttachmentTokens ? inputTextTokens : Number(usage?.input_tokens || inputTextTokens || 0);
    const countedOutput = shouldExcludeAttachmentTokens ? outputTextTokens : Number(usage?.output_tokens || outputTextTokens || 0);

    if (role !== "admin") {
      const reservedInput = Number(tokenReservation.reservation?.reserveInput || 0);
      const reservedOutput = Number(tokenReservation.reservation?.reserveOutput || 0);
      const deltaInput = countedInput - reservedInput;
      const deltaOutput = countedOutput - reservedOutput;

      if (deltaInput !== 0 || deltaOutput !== 0) {
        await adjustTokenUsage({
          role,
          table: tokenReservation.table,
          userId,
          periodKey: tokenReservation.periodKey,
          model,
          deltaInput,
          deltaOutput,
        });
      }
      reservationContext = null;
    }

    // Remaining
    let remaining = "Unlimited";
    if (role !== "admin") {
      const { used: usedAfter, limit: limitAfter } = await loadTokenUsage({ userId, role, tz, model });
      remaining = Math.max(0, Number(limitAfter) - Number(usedAfter));
    }

    return json(res, 200, {
      reply,
      model,
      usage: {
        counted_input_tokens: countedInput,
        counted_output_tokens: countedOutput,
        raw_input_tokens: Number(usage?.input_tokens || 0),
        raw_output_tokens: Number(usage?.output_tokens || 0),
        attachment_tokens_excluded: attachments.length > 0 && !usedFallbackTotals,
      },
      remaining_tokens: remaining,
    });
  } catch (error) {
    if (reservationContext) {
      try {
        await adjustTokenUsage({
          role: reservationContext.role,
          table: reservationContext.table,
          userId: reservationContext.userId,
          periodKey: reservationContext.periodKey,
          model: reservationContext.model,
          deltaInput: -reservationContext.reservedInput,
          deltaOutput: -reservationContext.reservedOutput,
        });
      } catch (rollbackErr) {
        console.error("AI quota rollback failed:", rollbackErr?.message || "unknown");
      }
    }

    console.error("Server error:", error?.message || "unknown");
    return json(res, 500, { error: "Server error" });
  }
};