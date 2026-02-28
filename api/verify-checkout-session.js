const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16"
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: "Missing session id" });
    }

    const session =
      await stripe.checkout.sessions.retrieve(
        sessionId
      );

    if (session.payment_status !== "paid") {
      return res.json({ verified: false });
    }

    const subscription =
      await stripe.subscriptions.retrieve(
        session.subscription
      );

    const userId =
      subscription.metadata?.user_id ||
      session.metadata?.user_id;

    if (!userId) {
      return res.json({ verified: false });
    }

    const tier =
      subscription.metadata?.plan || "free";

    await supabaseAdmin
      .from("user_settings")
      .upsert({
        user_id: userId,
        tier,
        role: tier,
        stripe_subscription_id: subscription.id,
        updated_at: new Date().toISOString()
      });

    return res.json({
      verified: true,
      tier
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: "Verification failed"
    });
  }
};