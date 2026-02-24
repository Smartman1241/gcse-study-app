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
    day: "2-digit"
  });
  return dtf.format(new Date());
}
<!-- redeploy -->

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
      .select("role, timezone")
      .eq("user_id", userId)
      .maybeSingle();

    const role = settings?.role || "user";

    // ---------- INPUT ----------
    const { question, topic, history, timezone } = req.body || {};
    const userQuestion = (question || topic || "").trim();

    if (!userQuestion) {
      return res.status(400).json({ error: "No question provided" });
    }

    const tz = timezone || settings?.timezone || "UTC";
    const day = todayInTimezone(tz);

    // ---------- DAILY USAGE ----------
    let { data: usage } = await supabaseAdmin
      .from("ai_usage_daily")
      .select("*")
      .eq("user_id", userId)
      .eq("day", day)
      .maybeSingle();

    if (!usage) {
      const { data: newRow } = await supabaseAdmin
        .from("ai_usage_daily")
        .insert([{ user_id: userId, day, input_tokens: 0, output_tokens: 0 }])
        .select()
        .single();

      usage = newRow;
    }

    const usedTokens =
      (usage.input_tokens || 0) +
      (usage.output_tokens || 0);

    const DAILY_LIMIT = 1500;

    if (role !== "admin" && usedTokens >= DAILY_LIMIT) {
      return res.status(429).json({
        error: "Sorry, you have run out of AI usage for today."
      });
    }

    // ---------- OUTPUT TOKEN LaOGIC ----------
    let maxOutputTokens = 250;

    const isDetailed = /detailed/i.test(userQuestion);

    if (isDetailed) {
      if (usedTokens + 500 <= DAILY_LIMIT) {
        maxOutputTokens = 500;
      } else if (usedTokens + 250 <= DAILY_LIMIT) {
        maxOutputTokens = 250;
      } else {
        return res.status(429).json({
          error: "Sorry, you have run out of AI usage for today."
        });
      }
    } else {
      if (usedTokens + 250 > DAILY_LIMIT && role !== "admin") {
        return res.status(429).json({
          error: "Sorry, you have run out of AI usage for today."
        });
      }
    }

    // ---------- SYSTEM PROMPT ----------
    const inputPayload = [
      {
        role: "system",
        content:
          "You are a professional GCSE tutor. " +
          "Give clear, exam-style answers. " +
          "Do NOT use markdown symbols. " +
          "Do NOT use LaTeX. " +
          "Write chemical formulas using Unicode subscripts like CO₂. " +
          "Keep answers concise unless user asks for detailed."
      },
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: userQuestion }
    ];

    // ---------- OPENAI REQUEST ----------
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: inputPayload,
        max_output_tokens: maxOutputTokens,
        temperature: 0.7
      })
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json({
        error: data?.error?.message || "OpenAI request failed"
      });
    }

    const reply =
      data?.output?.[0]?.content?.[0]?.text ||
      "No response generated.";

    const promptTokens = Number(data?.usage?.input_tokens || 0);
    const completionTokens = Number(data?.usage?.output_tokens || 0);

    // ---------- UPDATE USAGE ----------
    if (role !== "admin") {
      await supabaseAdmin
        .from("ai_usage_daily")
        .update({
          input_tokens: (usage.input_tokens || 0) + promptTokens,
          output_tokens: (usage.output_tokens || 0) + completionTokens,
          updated_at: new Date().toISOString()
        })
        .eq("user_id", userId)
        .eq("day", day);
    }

    return res.status(200).json({
      reply,
      usage: { promptTokens, completionTokens },
      remaining_tokens:
        role === "admin"
          ? "Unlimited"
          : DAILY_LIMIT - (usedTokens + promptTokens + completionTokens)
    });

  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};