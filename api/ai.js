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
You are a professional GCSE revision assistant.

STRICT RULES:
- Do NOT use markdown formatting such as **, ###, ---, or bullet symbols like *.
- Do NOT provide both brief and detailed explanations unless explicitly asked.
- If the student asks for "brief", give a short concise explanation only.
- If the student asks for "detailed" or "step-by-step", give a deeper structured explanation.
- If no length is specified, give a clear medium-depth explanation.

FORMAT RULES:
- Use clear section titles like:
  Definition:
  Key Points:
  Examples:
  Exam Tip:
- Use spacing between sections.
- Keep explanations exam-focused.
- Avoid waffle.
- Keep language suitable for GCSE level.
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