const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16"
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function missingEnv() {
  const required = [
    "STRIPE_SECRET_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY"
  ];
  return required.filter((k) => !process.env[k]);
}

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

module.exports = async (req, res) => {
  try {
    const missing = missingEnv();
    if (missing.length) {
      return res.status(500).json({ error: `Server misconfigured: missing ${missing.join(", ")}` });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    const accessToken = authHeader.slice(7).trim();
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(accessToken);
    if (userErr || !userData?.user?.id) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const userId = userData.user.id;
    const customerEmail = userData.user.email || undefined;

    const { priceId, waiveConfirmed } = req.body || {};

    // 🔒 1. Validate priceId strictly
    if (!priceId || !PRICE_MAP[priceId]) {
      return res.status(400).json({ error: "Invalid price ID" });
    }

    // 🔒 2. Enforce waiver confirmation (LEGAL PROTECTION)
    if (waiveConfirmed !== true) {
      return res.status(400).json({
        error: "You must agree to immediate access and waive cancellation rights."
      });
    }

    // 🔒 3. Derive plan & cycle server-side only
    const { plan, cycle } = PRICE_MAP[priceId];

    // 🔒 4. Determine base URL safely
    const origin =
      req.headers.origin ||
      (req.headers.host ? `https://${req.headers.host}` : null);

    if (!origin) {
      return res.status(400).json({ error: "Unable to determine base URL" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      allow_promotion_codes: true,

      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],

      customer_email: customerEmail,

      metadata: {
        user_id: userId,
        plan,
        cycle,
        waive_confirmed: "true"
      },

      subscription_data: {
        metadata: {
          user_id: userId,
          plan,
          cycle,
          waive_confirmed: "true"
        }
      },

      success_url: `${origin}/subscriptions.html?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/subscriptions.html?canceled=1`
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("Checkout error:", err);
    return res.status(500).json({
      error: "Unable to create checkout session"
    });
  }
};
