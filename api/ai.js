export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Accept BOTH question and topic (fixes mismatch bug)
    const { question, topic, history } = req.body || {};
    const userQuestion = question || topic;

    if (!userQuestion || typeof userQuestion !== "string") {
      return res.status(400).json({ error: "No question provided" });
    }

    // ===== TOKEN CONTROL =====
    const lower = userQuestion.toLowerCase();
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

    // ===== BUILD MESSAGE HISTORY =====
    const messages = [
      {
        role: "system",
        content:
          "You are a professional GCSE tutor. " +
          "Give clear, exam-style answers. " +
          "Do NOT use markdown symbols like ** or *. " +
          "Do NOT use LaTeX. " +
          "Write chemical formulas using HTML subscript tags like CO<sub>2</sub>. " +
          "Keep answers concise unless user asks for detailed."
      },
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: userQuestion }
    ];

    // ===== CALL OPENAI =====
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        max_tokens: maxTokens,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json({
        error: data.error?.message || "OpenAI request failed"
      });
    }

    const reply =
      data?.choices?.[0]?.message?.content || "No response generated.";

    return res.status(200).json({ reply });

  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Server error" });
  }
}