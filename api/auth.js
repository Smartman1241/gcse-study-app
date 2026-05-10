// /api/auth.js
import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

// ===============================
// RATE LIMITING
// ===============================
async function checkRateLimit(key, maxAttempts, windowMinutes) {
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMinutes * 60000);

  // Get current throttle record
  const { data: existing } = await supabase
    .from('throttle')
    .select('count, reset_at')
    .eq('key', key)
    .maybeSingle();

  // If record exists and not expired
  if (existing) {
    const resetTime = new Date(existing.reset_at);

    // If window has expired, allow and reset
    if (now >= resetTime) {
      await supabase
        .from('throttle')
        .upsert({ key, count: 1, reset_at: resetAt.toISOString() });
      return { allowed: true, remaining: maxAttempts - 1 };
    }

    // If under limit, increment
    if (existing.count < maxAttempts) {
      await supabase
        .from('throttle')
        .update({ count: existing.count + 1 })
        .eq('key', key);
      return { allowed: true, remaining: maxAttempts - existing.count - 1 };
    }

    // Rate limit exceeded
    const retryAfter = Math.ceil((resetTime - now) / 1000);
    return { allowed: false, retryAfter };
  }

  // First attempt - create record
  await supabase
    .from('throttle')
    .insert({ key, count: 1, reset_at: resetAt.toISOString() });

  return { allowed: true, remaining: maxAttempts - 1 };
}

export default async function handler(req, res) {
  try {
    const { type, email, password } = req.body;

    // Rate limit password reset (5 per 15 minutes per email)
    if (type === 'reset') {
      const throttleKey = `reset:${email}`;
      const rateCheck = await checkRateLimit(throttleKey, 5, 15);

      if (!rateCheck.allowed) {
        return res.status(429).json({
          error: `Too many password reset attempts. Try again in ${rateCheck.retryAfter} seconds.`,
          retryAfter: rateCheck.retryAfter
        });
      }
    }

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