const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

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


// ===============================
// RAW BODY
// ===============================
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


// ===============================
// FIND USER VIA STRIPE CUSTOMER
// ===============================
async function findUser(customerId) {

  const { data } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  return data?.id || null;
}


// ===============================
// UPDATE USER PLAN
// ===============================
async function updateUser(userId, tier, subscriptionId) {

  const payload = {
    user_id: userId,
    tier: tier,
    role: tier,
    stripe_subscription_id: subscriptionId,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabaseAdmin
    .from("user_settings")
    .upsert(payload);

  if (error) {
    console.error("User update failed:", error);
    throw error;
  }
}


// ===============================
// RESOLVE PLAN
// ===============================
function resolveTier(subscription) {

  if (!ACTIVE.has(subscription.status)) {
    return "free";
  }

  return subscription.metadata?.plan || "free";
}


// ===============================
// WEBHOOK
// ===============================
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

      // ===============================
      // FIRST PURCHASE
      // ===============================
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

        const tier = resolveTier(subscription);

        await updateUser(
          userId,
          tier,
          subscription.id
        );

        break;
      }


      // ===============================
      // RENEWALS + PLAN CHANGES
      // ===============================
      case "invoice.paid":
      case "customer.subscription.updated": {

        const obj = event.data.object;

        const subscription =
          obj.object === "subscription"
            ? obj
            : await stripe.subscriptions.retrieve(
                obj.subscription
              );

        const userId =
          subscription.metadata?.user_id ||
          await findUser(subscription.customer);

        if (!userId) break;

        const tier = resolveTier(subscription);

        await updateUser(
          userId,
          tier,
          subscription.id
        );

        break;
      }


      // ===============================
      // PAYMENT FAILED
      // ===============================
      case "invoice.payment_failed": {

        const invoice = event.data.object;

        const subscription =
          await stripe.subscriptions.retrieve(
            invoice.subscription
          );

        const userId =
          subscription.metadata?.user_id ||
          await findUser(subscription.customer);

        if (!userId) break;

        await updateUser(
          userId,
          "free",
          subscription.id
        );

        break;
      }


      // ===============================
      // CANCELLED
      // ===============================
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