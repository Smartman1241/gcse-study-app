const Stripe = require("stripe");
const { createClient: supabaseFactory } = require("@supabase/supabase-js");
const { buffer } = require("micro");

export const config = {
  api: {
    bodyParser: false
  }
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16"
});

const supabaseAdmin = supabaseFactory(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
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

      // ✅ SUBSCRIPTION CREATED VIA CHECKOUT
      case "checkout.session.completed": {
        const session = event.data.object;

        if (session.mode !== "subscription") break;

        const subscriptionId = session.subscription;
        const metadataUserId = session.metadata?.user_id;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const plan = subscription.metadata?.plan || "free";

        let userId = metadataUserId;

        // Fallback: find by email if metadata missing
        if (!userId) {
          const email = session.customer_details?.email;
          if (!email) break;

          const { data: users } = await supabaseAdmin.auth.admin.listUsers();
          const matched = users?.users?.find(u => u.email === email);
          if (!matched) break;

          userId = matched.id;
        }

        await supabaseAdmin
          .from("user_settings")
          .upsert({
            user_id: userId,
            tier: plan,
            stripe_subscription_id: subscriptionId,
            updated_at: new Date().toISOString()
          });

        break;
      }

      // ❌ SUBSCRIPTION CANCELLED
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const userId = subscription.metadata?.user_id;

        if (!userId) break;

        await supabaseAdmin
          .from("user_settings")
          .update({
            tier: "free",
            stripe_subscription_id: null,
            updated_at: new Date().toISOString()
          })
          .eq("user_id", userId);

        break;
      }

      // 💳 PAYMENT FAILED
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        if (!subscriptionId) break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const userId = subscription.metadata?.user_id;

        if (!userId) break;

        await supabaseAdmin
          .from("user_settings")
          .update({
            tier: "free",
            updated_at: new Date().toISOString()
          })
          .eq("user_id", userId);

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