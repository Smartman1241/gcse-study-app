const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

// Fail fast if env is missing (prevents confusing production errors)
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}
if (!process.env.SUPABASE_URL) {
  throw new Error("Missing SUPABASE_URL env var");
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY env var");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16"
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/*
  Price Mapping (Single Source of Truth)
  Never trust frontend for plan/cycle.
*/
const PRICE_MAP = {
  price_1T46nyRzC23qaxzMIu41ccnt: { plan: "plus", cycle: "monthly" },
  price_1T46nyRzC23qaxzM2apXOsNE: { plan: "plus", cycle: "quarterly" },
  price_1T46nyRzC23qaxzMsuQppAj6: { plan: "plus", cycle: "annual" },
  price_1T46qbRzC23qaxzM2ebMn3o6: { plan: "pro", cycle: "monthly" },
  price_1T46qbRzC23qaxzMh15YdWfh: { plan: "pro", cycle: "quarterly" },
  price_1T46qbRzC23qaxzMC9TWNVsK: { plan: "pro", cycle: "annual" }
};

function safeString(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function getOrigin(req) {
  // Prefer Origin header (browser requests). Otherwise fall back to host.
  const origin = safeString(req.headers.origin);
  if (origin) return origin;

  const host = safeString(req.headers.host);
  if (!host) return null;

  // Best-effort: assume HTTPS in production
  return `https://${host}`;
}

function getBearerToken(req) {
  const authHeader = safeString(req.headers.authorization) || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  return safeString(authHeader.slice(7));
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const priceId = safeString(body.priceId);
    const waiveConfirmed = body.waiveConfirmed;

    // 🔒 Validate priceId strictly
    if (!priceId || !PRICE_MAP[priceId]) {
      return res.status(400).json({ error: "Invalid price ID" });
    }

    // 🔒 Enforce waiver confirmation (LEGAL PROTECTION)
    if (waiveConfirmed !== true) {
      return res.status(400).json({
        error: "You must agree to immediate access and waive cancellation rights."
      });
    }

    const { plan, cycle } = PRICE_MAP[priceId];

    // 🔒 Determine base URL safely
    const origin = getOrigin(req);
    if (!origin) {
      return res.status(400).json({ error: "Unable to determine base URL" });
    }

    // 🔒 Verify user from Supabase session (never trust frontend userId)
    const accessToken = getBearerToken(req);
    if (!accessToken) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    const { data: userData, error: userErr } =
      await supabaseAdmin.auth.getUser(accessToken);

    const userId = userData?.user?.id || null;
// ===============================
// Get or create Stripe customer
// ===============================

const { data: profile, error: profileError } =
  await supabaseAdmin
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", userId)
    .single();

if (profileError) {
  console.error("Profile fetch error:", profileError);
}

// ===============================
// Get or create Stripe customer (mode-safe)
// ===============================

let customerId = profile?.stripe_customer_id || null;

async function createCustomer() {

  const customer = await stripe.customers.create({
    metadata: {
      user_id: userId
    }
  });

  await supabaseAdmin
    .from("profiles")
    .update({
      stripe_customer_id: customer.id
    })
    .eq("id", userId);

  return customer.id;
}

// If customer exists, verify it belongs to this Stripe mode
if (customerId) {
  try {
    await stripe.customers.retrieve(customerId);
  } catch (err) {
    console.log("Customer invalid for this Stripe mode — recreating");
    customerId = await createCustomer();
  }
} else {
  customerId = await createCustomer();
}
    if (userErr || !userId) {
      return res.status(401).json({ error: "Invalid session" });
    }

    // ✅ Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      allow_promotion_codes: true,

      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],

      // customer_email is optional, but helpful for receipts / recovery flows

      // ✅ Metadata for webhook mapping (checkout + subscription lifecycle)
      metadata: {
        plan,
        cycle,
        user_id: userId,
        waive_confirmed: "true"
      },

      subscription_data: {
        metadata: {
          plan,
          cycle,
          user_id: userId,
          waive_confirmed: "true"
        }
      },

      // ✅ Existing route (prevents 404 after payment)
      success_url: `${origin}/subscriptions.html?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/subscriptions.html?canceled=1`
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("Checkout error:", err);
    return res.status(500).json({ error: "Unable to create checkout session" });
  }
};