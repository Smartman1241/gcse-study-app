const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

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

async function getAuthUser(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return { error: "Missing auth token" };

  const accessToken = authHeader.slice(7).trim();
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { error: "Invalid session" };

  return { user: data.user };
}

function resolveOrigin(req) {
  const origin = String(req.headers.origin || "").trim();
  if (origin.startsWith("https://") || origin.startsWith("http://localhost")) {
    return origin;
  }

  const host = String(req.headers.host || "").trim();
  if (!host) return null;

  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const safeProto = proto === "http" || proto === "https" ? proto : "https";
  return `${safeProto}://${host}`;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const auth = await getAuthUser(req);
    if (auth.error) {
      return res.status(401).json({ error: auth.error });
    }

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
    const origin = resolveOrigin(req);
    if (!origin) {
      return res.status(400).json({ error: "Unable to determine base URL" });
    }

    const customerEmail = auth.user.email || undefined;

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
        user_id: auth.user.id,
        plan,
        cycle,
        waive_confirmed: "true"
      },

      subscription_data: {
        metadata: {
          user_id: auth.user.id,
          plan,
          cycle,
          waive_confirmed: "true"
        }
      },

      success_url: `${origin}/account.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
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
