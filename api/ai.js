const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Convert "now" into YYYY-MM-DD for a given IANA timezone
function todayInTimezone(tz) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return dtf.format(new Date());
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // ---------- AUTH ----------
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    const accessToken = authHeader.slice(7).trim();

    const { data: userData, error: userErr } =
      await supabaseAdmin.auth.getUser(accessToken);

    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const userId = userData.user.id;

    // ---------- SETTINGS ----------
    const { data: settings } = await supabaseAdmin
      .from("user_settings")
      .select("role, tier, timezone")
      .eq("user_id", userId)
      .maybeSingle();

    // ---------- INPUT ----------
    const { question, topic, history, timezone } = req.body || {};
    const userQuestion = (question || topic || "").trim();

    if (!userQuestion) {
      return res.status(400).json({ error: "No question provided" });
    }

    // ---------- TIMEZONE ----------
    const tzCandidate =
      typeof timezone === "string" && timezone.length < 80
        ? timezone
        : null;

    const tz = tzCandidate || settings?.timezone || "UTC";

    if (!settings?.timezone || (tzCandidate && tzCandidate !== settings.timezone)) {
      await supabaseAdmin.from("user_settings").upsert({
        user_id: userId,
        timezone: tz,
        updated_at: new Date().toISOString()
      });
    }

    // ---------- DAILY ROW ----------
    const day = todayInTimezone(tz);

    let { data: usage } = await supabaseAdmin
      .from("ai_usage_daily")
      .select("*")
      .eq("user_id", userId)
      .eq("day", day)
      .maybeSingle();

    if (!usage) {
      const { data: newRow } = await supabaseAdmin
        .from("ai_usage_daily")
        .insert([{ user_id: userId, day }])
        .select()
        .single();

      usage = newRow;
    }

    const inputUsed = usage.input_tokens || 0;
    const outputUsed = usage.output_tokens || 0;
    const nanoUsed = usage.nano_tokens || 0;

    // ---------- MODEL SELECTION ----------
    let model;

    if (settings?.role === "admin") {
      model = "gpt-4o-mini"; // safe default for admin
    } else {
      if (inputUsed < 400 && outputUsed < 400) {
        model = "gpt-5-mini";
      } else if (inputUsed < 1500 && outputUsed < 1500) {
        model = "gpt-4o-mini";
      } else if (nanoUsed < 3000) {
        model = "gpt-5-nano";
      } else {
        return res.status(429).json({
          error: "Daily AI limit reached. Try again after midnight in your timezone."
        });
      }
    }

    const maxOutputTokens = 1500;

    // ---------- SYSTEM PROMPT ----------
    const inputPayload = [
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

    // ---------- OPENAI REQUEST (RESPONSES API) ----------
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        input: inputPayload,
        max_output_tokens: maxOutputTokens,
        temperature: model === "gpt-4o-mini" ? 0.7 : undefined
      })
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json({
        error: data?.error?.message || "OpenAI request failed"
      });
    }

    // ---------- EXTRACT RESPONSE ----------
    const reply =
      data?.output?.[0]?.content?.[0]?.text ||
      "No response generated.";

    // ---------- TOKEN TRACKING ----------
    const promptTokens = Number(data?.usage?.input_tokens || 0);
    const completionTokens = Number(data?.usage?.output_tokens || 0);

    if (settings?.role !== "admin") {
      if (model === "gpt-5-nano") {
        await supabaseAdmin.from("ai_usage_daily").update({
          nano_tokens: nanoUsed + promptTokens + completionTokens,
          updated_at: new Date().toISOString()
        }).eq("user_id", userId).eq("day", day);
      } else {
        await supabaseAdmin.from("ai_usage_daily").update({
          input_tokens: inputUsed + promptTokens,
          output_tokens: outputUsed + completionTokens,
          updated_at: new Date().toISOString()
        }).eq("user_id", userId).eq("day", day);
      }
    }

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
};