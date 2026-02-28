// api/stripe-webhook.js

const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

// ✅ Required for Stripe signature verification on Vercel
module.exports.config = {
  api: {
    bodyParser: false
  }
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16"
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ACTIVE = new Set(["active", "trialing"]);

function safe(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ===============================
// RAW BODY (replaces micro)
// ===============================
async function getRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk
    );
  }

  return Buffer.concat(chunks);
}

// ===============================
// Find user via Stripe customer
// ===============================
async function findUserByCustomer(customerId) {
  if (!customerId) return null;

  const { data } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  return data?.id || null;
}

// ===============================
// Update subscription state
// ===============================
async function updateUser(userId, tier, subscriptionId) {

  await supabaseAdmin
    .from("user_settings")
    .upsert({
      user_id: userId,
      tier,
      role: tier,
      stripe_subscription_id: subscriptionId,
      updated_at: new Date().toISOString()
    });
}

// ===============================
// WEBHOOK HANDLER
// ===============================
module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const sig = req.headers["stripe-signature"];

  let event;

  // ===============================
  // Verify Stripe signature
  // ===============================
  try {

    const rawBody = await getRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

  } catch (err) {

    console.error("❌ Signature verification failed:", err.message);

    return res.status(400).send("Invalid signature");
  }

  // ===============================
  // Idempotency protection
  // ===============================
  const { error: dup } = await supabaseAdmin
    .from("stripe_events")
    .insert({ id: event.id });

  if (dup) {
    return res.status(200).send("Duplicate ignored");
  }

  try {

    switch (event.type) {

      // ===============================
      // Checkout completed
      // ===============================
      case "checkout.session.completed": {

        const session = event.data.object;

        if (session.mode !== "subscription") break;

        const subscription =
          await stripe.subscriptions.retrieve(
            session.subscription
          );

        let userId =
          safe(subscription.metadata?.user_id) ||
          safe(session.metadata?.user_id);

        if (!userId) {
          userId = await findUserByCustomer(
            session.customer
          );
        }

        if (!userId) break;

        const tier =
          ACTIVE.has(subscription.status)
            ? safe(subscription.metadata?.plan) || "free"
            : "free";

        await updateUser(
          userId,
          tier,
          subscription.id
        );

        break;
      }

      // ===============================
      // Subscription updated
      // ===============================
      case "customer.subscription.updated": {

        const sub = event.data.object;

        let userId =
          safe(sub.metadata?.user_id) ||
          await findUserByCustomer(sub.customer);

        if (!userId) break;

        const tier =
          ACTIVE.has(sub.status)
            ? safe(sub.metadata?.plan) || "free"
            : "free";

        await updateUser(userId, tier, sub.id);

        break;
      }

      // ===============================
      // Subscription cancelled
      // ===============================
      case "customer.subscription.deleted": {

        const sub = event.data.object;

        const userId =
          safe(sub.metadata?.user_id) ||
          await findUserByCustomer(sub.customer);

        if (!userId) break;

        await updateUser(userId, "free", null);

        break;
      }

      // ===============================
      // Payment failed
      // ===============================
      case "invoice.payment_failed": {

        const invoice = event.data.object;

        const sub =
          await stripe.subscriptions.retrieve(
            invoice.subscription
          );

        const userId =
          safe(sub.metadata?.user_id) ||
          await findUserByCustomer(sub.customer);

        if (!userId) break;

        await updateUser(userId, "free", sub.id);

        break;
      }

      // ===============================
      // Payment success
      // ===============================
      case "invoice.paid": {

        const invoice = event.data.object;

        const sub =
          await stripe.subscriptions.retrieve(
            invoice.subscription
          );

        const userId =
          safe(sub.metadata?.user_id) ||
          await findUserByCustomer(sub.customer);

        if (!userId) break;

        const tier =
          ACTIVE.has(sub.status)
            ? safe(sub.metadata?.plan) || "free"
            : "free";

        await updateUser(userId, tier, sub.id);

        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });

  } catch (err) {

    console.error("🔥 Webhook processing error:", err);

    return res.status(500).json({
      error: "Webhook failed"
    });
  }
};