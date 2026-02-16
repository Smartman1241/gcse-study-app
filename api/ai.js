import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Convert "now" into YYYY-MM-DD for a given IANA timezone (e.g. Europe/London)
function todayInTimezone(tz) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  // en-CA gives YYYY-MM-DD format
  return dtf.format(new Date());
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // ----- Auth -----
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing auth token" });
    }
    const accessToken = authHeader.slice("Bearer ".length).trim();

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(accessToken);
    const user = userData?.user;
    if (userErr || !user) return res.status(401).json({ error: "Invalid session" });

    const userId = user.id;

    // ----- Input -----
    const { question, topic, history, timezone } = req.body || {};
    const userQuestion = (question || topic || "").trim();
    if (!userQuestion) return res.status(400).json({ error: "No question provided" });

    // ----- Store / read timezone -----
    const tzCandidate = typeof timezone === "string" && timezone.length < 80 ? timezone : null;

    // Read existing settings
    const { data: settingsRow } = await supabaseAdmin
      .from("user_settings")
      .select("timezone")
      .eq("user_id", userId)
      .single();

    const tz = tzCandidate || settingsRow?.timezone || "UTC";

    // Upsert timezone if missing or changed (so reset follows user timezone)
    if (!settingsRow?.timezone || (tzCandidate && tzCandidate !== settingsRow.timezone)) {
      await supabaseAdmin
        .from("user_settings")
        .upsert({ user_id: userId, timezone: tz, updated_at: new Date().toISOString() });
    }

    // ----- Determine local day -----
    let day;
    try {
      day = todayInTimezone(tz);
    } catch {
      day = todayInTimezone("UTC");
    }

    // ----- Get or create usage row -----
    let { data: usage } = await supabaseAdmin
      .from("ai_usage_daily")
      .select("*")
      .eq("user_id", userId)
      .eq("day", day)
      .single();

    if (!usage) {
      const ins = await supabaseAdmin
        .from("ai_usage_daily")
        .insert([{ user_id: userId, day }])
        .select()
        .single();
      usage = ins.data;
    }

    const inputUsed = usage.input_tokens || 0;
    const outputUsed = usage.output_tokens || 0;
    const nanoUsed = usage.nano_tokens || 0;

    // ----- Decide model + enforce caps -----
    let model;
    let maxTokens = 1500; // output cap per request (we’ll still enforce daily usage)
    // Your per-request output cap requirement:
    // "limit it to 1500 tokens of output"
    // We'll cap completion tokens to 1500, but daily output still enforced below.

    if (inputUsed < 400 && outputUsed < 400) {
      model = "gpt-5-mini";
      maxTokens = 1500; // still allow up to 1500 in one response, but daily output will stop at 400 for this phase
    } else if (inputUsed < 1500 && outputUsed < 1500) {
      model = "gpt-4o-mini";
      maxTokens = 1500;
    } else if (nanoUsed < 3000) {
      // Flex mode fallback
      model = "gpt-5-nano";
      maxTokens = 1500;
    } else {
      return res.status(429).json({ error: "Daily AI limit reached. Try again after midnight in your timezone." });
    }

    // ----- System prompt -----
    const messages = [
      {
        role: "system",
        content:
          "You are a professional GCSE tutor. " +
          "Give clear, exam-style answers. " +
          "Do NOT use markdown symbols like ** or *. " +
          "Do NOT use LaTeX. " +
          "Write chemical formulas using proper Unicode subscript characters like CO₂, H₂O, C₆H₁₂O₆. " +
          "Do NOT use HTML tags. " +
          "Keep answers concise unless user asks for detailed."
      },
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: userQuestion }
    ];

    // ----- Call OpenAI -----
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      const bodyPayload = {
  model,
  messages,
  max_completion_tokens: maxTokens
};

// Only add temperature for GPT-4o models
if (model.startsWith("gpt-4o")) {
  bodyPayload.temperature = 0.7;
}

const resp = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
  },
  body: JSON.stringify(bodyPayload)
});
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json({ error: data?.error?.message || "OpenAI request failed" });
    }

    const reply = data?.choices?.[0]?.message?.content || "No response generated.";

    // ----- Token accounting -----
    const promptTokens = Number(data?.usage?.prompt_tokens || 0);
    const completionTokens = Number(data?.usage?.completion_tokens || 0);

    // Enforce DAILY limits after the fact (hard stop next call).
    // We still log what was used so a user can’t bypass by sending huge prompts.
    if (model === "gpt-5-nano") {
      await supabaseAdmin
        .from("ai_usage_daily")
        .update({
          nano_tokens: nanoUsed + promptTokens + completionTokens,
          updated_at: new Date().toISOString()
        })
        .eq("user_id", userId)
        .eq("day", day);
    } else {
      await supabaseAdmin
        .from("ai_usage_daily")
        .update({
          input_tokens: inputUsed + promptTokens,
          output_tokens: outputUsed + completionTokens,
          updated_at: new Date().toISOString()
        })
        .eq("user_id", userId)
        .eq("day", day);
    }

    // Optional: return usage info (helpful for UI)
    return res.status(200).json({
      reply,
      model_used: model,
      usage: { promptTokens, completionTokens },
      day,
      timezone: tz
    });

  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Server error" });
  }
}