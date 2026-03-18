import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  try {
    const { type, email, password } = req.body;

    if (!email) return res.status(400).json({ error: "Email is required" });
    if (type === 'signup' && !password) return res.status(400).json({ error: "Password is required" });

    if (type === 'signup') {
      const { data: userData, error: createError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true
      });
      if (createError) throw createError;

      await resend.emails.send({
        from: 'ReviseFlow <noreply@send.reviseflow.co.uk>',
        to: email,
        subject: 'Welcome to ReviseFlow!',
        html: `<p>Your account is ready. <a href="https://reviseflow.co.uk/login">Login here</a></p>`
      });

      return res.status(200).json({ success: true });
    }

    if (type === 'reset') {
      const { data: resetLink, error: resetError } = await supabase.auth.admin.generateResetPasswordLink(email);
      if (resetError) throw resetError;

      await resend.emails.send({
        from: 'ReviseFlow <noreply@send.reviseflow.co.uk>',
        to: email,
        subject: 'Reset your password',
        html: `<p>Click <a href="${resetLink}">here</a> to reset your password</p>`
      });

      return res.status(200).json({ success: true });
    }

    res.status(400).json({ error: 'Invalid request type' });

  } catch (err) {
    console.error("Auth API error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}