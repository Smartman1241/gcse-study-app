const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { buffer } = require("micro");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16"
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function upsertUserRole(userId, role, subscriptionId) {
  const normalizedRole = String(role || "free").toLowerCase();
  const payload = {
    user_id: userId,
    role: normalizedRole,
    tier: normalizedRole,
    stripe_subscription_id: subscriptionId || null,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabaseAdmin.from("user_settings").upsert(payload);
  if (error) throw error;
}

const handler = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).send("Missing Stripe signature");
  }

  let event;

  try {
    const rawBody = await buffer(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send("Invalid signature");
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "subscription") break;

        const subscriptionId = session.subscription;
        if (!subscriptionId) break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const plan = subscription.metadata?.plan || "free";
        const userId =
          subscription.metadata?.user_id ||
          session.metadata?.user_id ||
          null;

        if (!userId) {
          console.warn("Stripe webhook: missing metadata user_id for checkout.session.completed");
          break;
        }

        await upsertUserRole(userId, plan, subscriptionId);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const userId = subscription.metadata?.user_id;

        if (!userId) break;

        await upsertUserRole(userId, "free", null);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        if (!subscriptionId) break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const userId = subscription.metadata?.user_id;

        if (!userId) break;

        await upsertUserRole(userId, "free", subscriptionId);
        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).json({ error: "Webhook handler failed" });
  }
};

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false
  }
};
