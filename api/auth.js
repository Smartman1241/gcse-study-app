// /api/auth.js
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

    if (type === 'signup') {
      // Create user in Supabase
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true
      });
      if (error) throw error;

      // Send welcome email via Resend
      await resend.emails.send({
        from: 'ReviseFlow <noreply@send.reviseflow.co.uk>',
        to: email,
        subject: 'Welcome to ReviseFlow!',
        html: `<p>Your account is ready. <a href="https://reviseflow.co.uk/login">Login here</a></p>`
      });

      return res.status(200).json({ success: true, data });
    }

    if (type === 'reset') {
      // Generate reset link using Supabase Admin
      const { data, error } = await supabase.auth.admin.generatePasswordResetLink(email);
      if (error) throw error;

      // Send reset email via Resend
      await resend.emails.send({
        from: 'ReviseFlow <noreply@send.reviseflow.co.uk>',
        to: email,
        subject: 'Reset your password',
        html: `<p>Click <a href="${data}">here</a> to reset your password</p>`
      });

      return res.status(200).json({ success: true, data });
    }

    return res.status(400).json({ error: 'Invalid request type' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}