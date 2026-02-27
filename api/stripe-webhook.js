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

function json(res, code, payload) {
  return res.status(code).json(payload);
}

function roleFromPlan(plan) {
  const normalized = String(plan || "").toLowerCase();
  if (normalized === "pro") return "pro";
  if (normalized === "plus") return "plus";
  return "free";
}

async function markEventProcessing(event) {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .insert({
      event_id: event.id,
      event_type: event.type,
      status: "processing",
      processed_at: now,
      updated_at: now,
      last_error: null
    });

  if (!error) return { duplicate: false };
  if (error.code === "23505") return { duplicate: true };
  throw new Error(`Webhook idempotency insert failed: ${error.message}`);
}

async function updateEventStatus(eventId, status, lastError = null) {
  await supabaseAdmin
    .from("stripe_webhook_events")
    .update({
      status,
      last_error: lastError,
      updated_at: new Date().toISOString()
    })
    .eq("event_id", eventId);
}

async function resolveUserId({ explicitUserId, stripeCustomerId, stripeSubscriptionId }) {
  if (explicitUserId) return explicitUserId;

  if (stripeSubscriptionId) {
    const { data: subMap } = await supabaseAdmin
      .from("billing_subscription_map")
      .select("user_id")
      .eq("stripe_subscription_id", stripeSubscriptionId)
      .maybeSingle();

    if (subMap?.user_id) return subMap.user_id;
  }

  if (stripeCustomerId) {
    const { data: customerMap } = await supabaseAdmin
      .from("billing_customer_map")
      .select("user_id")
      .eq("stripe_customer_id", stripeCustomerId)
      .maybeSingle();

    if (customerMap?.user_id) return customerMap.user_id;
  }

  return null;
}

async function handleCheckoutCompleted(session) {
  if (session.mode !== "subscription") return;

  const subscriptionId = String(session.subscription || "");
  const stripeCustomerId = String(session.customer || "");
  const explicitUserId = String(session.client_reference_id || "") || null;

  if (!subscriptionId || !stripeCustomerId) {
    console.warn("checkout.session.completed missing subscription/customer");
    return;
  }

  const userId = await resolveUserId({
    explicitUserId,
    stripeCustomerId,
    stripeSubscriptionId: subscriptionId
  });

  if (!userId) {
    console.warn("Unable to resolve user for checkout.session.completed", { subscriptionId });
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const plan = subscription.metadata?.plan || session.metadata?.plan || "free";
  const role = roleFromPlan(plan);

  await supabaseAdmin.from("billing_customer_map").upsert({
    user_id: userId,
    stripe_customer_id: stripeCustomerId,
    updated_at: new Date().toISOString()
  });

  await supabaseAdmin.from("billing_subscription_map").upsert({
    stripe_subscription_id: subscriptionId,
    user_id: userId,
    stripe_customer_id: stripeCustomerId,
    status: subscription.status || "active",
    plan,
    updated_at: new Date().toISOString()
  });

  await supabaseAdmin
    .from("user_settings")
    .upsert({
      user_id: userId,
      tier: plan,
      role,
      stripe_subscription_id: subscriptionId,
      updated_at: new Date().toISOString()
    });
}

function getDowngradeSubscriptionId(eventType, object) {
  if (eventType === "invoice.payment_failed") {
    return String(object.subscription || "");
  }
  if (eventType === "customer.subscription.deleted") {
    return String(object.id || "");
  }
  return "";
}

async function handleSubscriptionDowngrade(eventType, subscriptionLike) {
  const subscriptionId = getDowngradeSubscriptionId(eventType, subscriptionLike);
  const stripeCustomerId = String(subscriptionLike.customer || "");

  if (!subscriptionId && !stripeCustomerId) return;

  const userId = await resolveUserId({
    explicitUserId: null,
    stripeCustomerId,
    stripeSubscriptionId: subscriptionId
  });

  if (!userId) {
    console.warn("Unable to resolve user for downgrade event", { subscriptionId, eventType });
    return;
  }

  await supabaseAdmin
    .from("user_settings")
    .update({
      tier: "free",
      role: "free",
      stripe_subscription_id: null,
      updated_at: new Date().toISOString()
    })
    .eq("user_id", userId);

  if (subscriptionId) {
    await supabaseAdmin
      .from("billing_subscription_map")
      .upsert({
        stripe_subscription_id: subscriptionId,
        user_id: userId,
        stripe_customer_id: stripeCustomerId || null,
        status: "canceled",
        plan: "free",
        updated_at: new Date().toISOString()
      });
  }
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return json(res, 400, { error: "Missing Stripe signature" });
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
    console.error("Webhook signature verification failed:", err?.message || "unknown");
    return json(res, 400, { error: "Invalid signature" });
  }

  try {
    const idem = await markEventProcessing(event);
    if (idem.duplicate) {
      return json(res, 200, { received: true, duplicate: true });
    }

    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDowngrade(event.type, event.data.object);
        break;
      case "invoice.payment_failed":
        await handleSubscriptionDowngrade(event.type, event.data.object);
        break;
      default:
        break;
    }

    await updateEventStatus(event.id, "processed", null);
    return json(res, 200, { received: true });
  } catch (err) {
    await updateEventStatus(event.id, "failed", String(err?.message || "unknown").slice(0, 500));
    console.error("Webhook processing error:", err?.message || "unknown");
    return json(res, 500, { error: "Webhook handler failed" });
  }
}

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false
  }
};
