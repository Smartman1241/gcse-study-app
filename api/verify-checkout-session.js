const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

/*
===============================
ENV VALIDATION
===============================
*/

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY");
}

if (!process.env.SUPABASE_URL) {
  throw new Error("Missing SUPABASE_URL");
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16"
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/*
===============================
HELPERS
===============================
*/

function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim();
}

/*
===============================
HANDLER
===============================
*/

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { sessionId } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({ error: "Missing sessionId" });
    }

    /*
    ===============================
    AUTHENTICATE USER
    ===============================
    */

    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    const { data: userData, error: authError } =
      await supabaseAdmin.auth.getUser(token);

    const authUserId = userData?.user?.id || null;

    if (authError || !authUserId) {
      return res.status(401).json({ error: "Invalid session" });
    }

    /*
    ===============================
    RETRIEVE STRIPE SESSION
    ===============================
    */

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session) {
      return res.status(404).json({ error: "Checkout session not found" });
    }

    if (session.payment_status !== "paid") {
      return res.json({ verified: false });
    }

    /*
    ===============================
    VERIFY SESSION OWNERSHIP
    ===============================
    */

    const metadataUserId = session.metadata?.user_id || null;

    if (!metadataUserId || metadataUserId !== authUserId) {
      return res.status(403).json({ error: "Session does not belong to authenticated user" });
    }

    /*
    ===============================
    GET SUBSCRIPTION SAFELY
    ===============================
    */

    let subscription = null;
    let tier = "free";

    if (session.mode === "subscription" && session.subscription) {
      subscription = await stripe.subscriptions.retrieve(session.subscription);
      tier = subscription.metadata?.plan || "free";

      // OPTIONAL: Ensure DB matches Stripe (Webhook should normally do this)
      await supabaseAdmin
        .from("user_settings")
        .upsert({
          user_id: authUserId,
          tier,
          role: tier,
          stripe_subscription_id: subscription.id,
          updated_at: new Date().toISOString()
        });
    }

    return res.json({
      verified: true,
      tier
    });

  } catch (err) {
    console.error("Checkout verification error:", err);
    return res.status(500).json({ error: "Verification failed" });
  }
};