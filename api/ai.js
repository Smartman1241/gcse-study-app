export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { question, history } = req.body;

    if (!question) {
      return res.status(400).json({ error: "No question provided" });
    }

    // ======== READ USAGE FROM COOKIES ========
    const cookies = Object.fromEntries(
      (req.headers.cookie || "")
        .split(";")
        .map(c => c.trim().split("="))
        .filter(c => c.length === 2)
    );

    let gpt5Count = Number(cookies.gpt5Count || 0);
    let gpt4Count = Number(cookies.gpt4Count || 0);

    // ======== MODEL LOGIC ========
    let model = "gpt-4o-mini";

    if (gpt5Count < 3) {
      model = "gpt-5-mini";
      gpt5Count++;
    } else if (gpt4Count < 7) {
      model = "gpt-4o-mini";
      gpt4Count++;
    } else {
      model = "gpt-4o-mini"; // stays on 4o-mini after limit
    }

    // ======== TOKEN CONTROL ========
    const lower = question.toLowerCase();
    let maxTokens = 250;

    const detailedKeywords = [
      "detailed",
      "in depth",
      "full explanation",
      "6 mark",
      "extended",
      "essay",
      "deep dive"
    ];

    if (detailedKeywords.some(k => lower.includes(k))) {
      maxTokens = 500;
    }

    // ======== BUILD MESSAGE HISTORY ========
    const messages = [
      {
        role: "system",
        content:
          "You are a professional GCSE tutor. " +
          "Give clear exam-style answers. " +
          "Do NOT use markdown symbols like ** or *. " +
          "Do NOT use LaTeX. " +
          "Use clean formatting and HTML <sub> for chemical formulas. " +
          "Keep answers concise unless user asks for detailed."
      },
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: question }
    ];

    // ======== CALL OPENAI ========
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: data.error?.message || "OpenAI error"
      });
    }

    let reply =
      data.choices?.[0]?.message?.content || "No response generated.";

    // ======== GPT-4 WARNING WHEN 2 LEFT ========
    const remainingGPT4 = 7 - gpt4Count;

    if (remainingGPT4 === 2) {
      reply +=
        "\n\nNote: You have 2 enhanced AI responses remaining before standard mode continues.";
    }

    // ======== UPDATE COOKIES ========
    res.setHeader("Set-Cookie", [
      `gpt5Count=${gpt5Count}; Path=/; HttpOnly`,
      `gpt4Count=${gpt4Count}; Path=/; HttpOnly`
    ]);

    return res.status(200).json({ reply });

  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
}