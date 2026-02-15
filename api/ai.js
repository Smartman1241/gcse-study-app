import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { topic } = req.body;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a GCSE revision assistant.

Adapt the explanation length and depth based on the student's request.
If they ask for brief, keep it concise.
If they ask for detailed or step-by-step, expand clearly.
Keep explanations exam-focused, clear, and structured.
Avoid unnecessary waffle.
`
        },
        {
          role: "user",
          content: topic
        }
      ],
      max_tokens: 500
    });

    res.status(200).json({
      reply: completion.choices[0].message.content
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "AI request failed" });
  }
}