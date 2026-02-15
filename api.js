export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { topic } = req.body;

    if (!topic) {
      return res.status(400).json({ error: "No topic provided" });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a GCSE tutor. Give clear exam-style answers suitable for exam revision." },
          { role: "user", content: topic }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || "OpenAI error" });
    }

    return res.status(200).json({
      reply: data.choices?.[0]?.message?.content || "No response generated"
    });

  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
}