const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

/*
  ===============================
  ENV VALIDATION
  ===============================
*/

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY env var");
}

if (!process.env.SUPABASE_URL) {
  throw new Error("Missing SUPABASE_URL env var");
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY env var");
}

if (!process.env.APP_URL) {
  throw new Error("Missing APP_URL env var (base site URL)");
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
  PRICE MAP (SERVER AUTHORITY)
  ===============================
*/

const PRICE_MAP = {
  price_1T46nyRzC23qaxzMIu41ccnt: { plan: "plus", cycle: "monthly" },
  price_1T46nyRzC23qaxzM2apXOsNE: { plan: "plus", cycle: "quarterly" },
  price_1T46nyRzC23qaxzMsuQppAj6: { plan: "plus", cycle: "annual" },
  price_1T46qbRzC23qaxzM2ebMn3o6: { plan: "pro", cycle: "monthly" },
  price_1T5v9oRzC23qaxzMWkfmzc1l: { plan: "pro", cycle: "quarterly" },
  price_1T46qbRzC23qaxzMC9TWNVsK: { plan: "pro", cycle: "annual" }
};

/*
  ===============================
  HELPERS
  ===============================
*/

function safeString(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function getBearerToken(req) {
  const authHeader = safeString(req.headers.authorization) || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  return safeString(authHeader.slice(7));
}

/*
  ===============================
  HANDLER
  ===============================
*/

module.exports = async function handler(req, res) {

  try {

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const priceId = safeString(body.priceId);
    const waiveConfirmed = body.waiveConfirmed;

    /*
      ===============================
      PRICE VALIDATION
      ===============================
    */

    if (!priceId || !PRICE_MAP[priceId]) {
      return res.status(400).json({ error: "Invalid price ID" });
    }

    if (waiveConfirmed !== true) {
      return res.status(400).json({
        error: "You must agree to immediate access and waive cancellation rights."
      });
    }

    const { plan, cycle } = PRICE_MAP[priceId];

    /*
      ===============================
      AUTH VALIDATION
      ===============================
    */

    const accessToken = getBearerToken(req);

    if (!accessToken) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    const { data: userData, error: userErr } =
      await supabaseAdmin.auth.getUser(accessToken);

    const userId = userData?.user?.id || null;

    if (userErr || !userId) {
      return res.status(401).json({ error: "Invalid session" });
    }

    /*
      ===============================
      PROFILE FETCH
      ===============================
    */

    const { data: profile, error: profileError } =
      await supabaseAdmin
        .from("profiles")
        .select("stripe_customer_id")
        .eq("id", userId)
        .maybeSingle();

    if (profileError) {
      console.error("Profile fetch error:", profileError);
      return res.status(500).json({ error: "Profile lookup failed" });
    }

    /*
      ===============================
      GET / CREATE STRIPE CUSTOMER (FIXED)
      ===============================
    */

    let customerId = profile?.stripe_customer_id || null;

    async function createCustomer() {

      const customer = await stripe.customers.create({
        metadata: { user_id: userId }
      });

      const { error: upsertError } = await supabaseAdmin
        .from("profiles")
        .update({ stripe_customer_id: customer.id })
        .eq("id", userId);

      if (upsertError) {
        console.error("Failed to update stripe_customer_id:", upsertError);
        throw new Error("Customer creation failed, DB update error");
      }

      return customer.id;
    }

    if (customerId) {
      try {
        await stripe.customers.retrieve(customerId);
      } catch (err) {
        console.warn("Customer invalid for this Stripe mode, recreating");
        customerId = await createCustomer();
      }
    } else {
      customerId = await createCustomer();
    }

    /*
      ===============================
      CREATE CHECKOUT SESSION
      ===============================
    */

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      allow_promotion_codes: true,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { plan, cycle, user_id: userId, waive_confirmed: "true" },
      subscription_data: {
        metadata: { plan, cycle, user_id: userId, waive_confirmed: "true" }
      },
      success_url: `${process.env.APP_URL}/subscriptions.html?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/subscriptions.html?canceled=1`
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("Checkout session error:", err);
    return res.status(500).json({ error: "Unable to create checkout session" });
  }
};