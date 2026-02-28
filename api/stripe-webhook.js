const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

export const config = {
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

async function getRawBody(readable) {
  const chunks = [];

  for await (const chunk of readable) {
    chunks.push(
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk
    );
  }

  return Buffer.concat(chunks);
}

async function findUser(customerId) {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  return data?.id || null;
}

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

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  let event;

  try {

    const rawBody = await getRawBody(req);

    const signature = req.headers["stripe-signature"];

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

  } catch (err) {

    console.error("Webhook signature failed:", err.message);

    return res.status(400).send("Invalid signature");
  }

  try {

    switch (event.type) {

      case "checkout.session.completed": {

        const session = event.data.object;

        if (session.mode !== "subscription") break;

        const subscription =
          await stripe.subscriptions.retrieve(
            session.subscription
          );

        let userId =
          subscription.metadata?.user_id ||
          session.metadata?.user_id ||
          await findUser(session.customer);

        if (!userId) break;

        const tier =
          ACTIVE.has(subscription.status)
            ? subscription.metadata?.plan || "free"
            : "free";

        await updateUser(
          userId,
          tier,
          subscription.id
        );

        break;
      }

      case "customer.subscription.updated":
      case "invoice.paid": {

        const sub = event.data.object;

        const subscription =
          sub.object === "subscription"
            ? sub
            : await stripe.subscriptions.retrieve(
                sub.subscription
              );

        const userId =
          subscription.metadata?.user_id ||
          await findUser(subscription.customer);

        if (!userId) break;

        const tier =
          ACTIVE.has(subscription.status)
            ? subscription.metadata?.plan || "free"
            : "free";

        await updateUser(
          userId,
          tier,
          subscription.id
        );

        break;
      }

      case "customer.subscription.deleted": {

        const sub = event.data.object;

        const userId =
          sub.metadata?.user_id ||
          await findUser(sub.customer);

        if (!userId) break;

        await updateUser(userId, "free", null);

        break;
      }
    }

    return res.status(200).json({ received: true });

  } catch (err) {

    console.error("Webhook processing error:", err);

    return res.status(500).json({
      error: "Webhook failed"
    });
  }
};