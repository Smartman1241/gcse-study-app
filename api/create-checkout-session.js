const Stripe = require("stripe");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16"
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PRICE_MAP = {
  price_1T46nyRzC23qaxzMIu41ccnt: { plan: "plus", cycle: "monthly" },
  price_1T46nyRzC23qaxzM2apXOsNE: { plan: "plus", cycle: "quarterly" },
  price_1T46nyRzC23qaxzMsuQppAj6: { plan: "plus", cycle: "annual" },
  price_1T46qbRzC23qaxzM2ebMn3o6: { plan: "pro", cycle: "monthly" },
  price_1T46qbRzC23qaxzMh15YdWfh: { plan: "pro", cycle: "quarterly" },
  price_1T46qbRzC23qaxzMC9TWNVsK: { plan: "pro", cycle: "annual" }
};

function json(res, code, payload) {
  return res.status(code).json(payload);
}

function deriveOrigin(req) {
  const envBase = String(process.env.APP_BASE_URL || "").trim();
  if (envBase) {
    try {
      const u = new URL(envBase);
      if (u.protocol === "https:" || u.protocol === "http:") {
        return `${u.protocol}//${u.host}`;
      }
    } catch {
      // ignore invalid APP_BASE_URL and fallback to localhost-only host check
    }
  }

  const host = String(req.headers.host || "").trim().toLowerCase();
  if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
    return `http://${host}`;
  }

  return null;
}

function normalizeIdempotencyKey(raw, userId, priceId) {
  const candidate = String(raw || "").trim();
  if (/^[a-zA-Z0-9:_-]{12,120}$/.test(candidate)) return candidate;

  const minuteBucket = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  return crypto
    .createHash("sha256")
    .update(`${userId}:${priceId}:${minuteBucket}`)
    .digest("hex")
    .slice(0, 48);
}

async function requireAuthUser(req) {
  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) return { error: "Missing auth token" };

  const accessToken = authHeader.slice(7).trim();
  if (!accessToken) return { error: "Missing auth token" };

  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { error: "Invalid session" };

  return { user: data.user };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "Method not allowed" });
    }

    const auth = await requireAuthUser(req);
    if (auth.error) return json(res, 401, { error: auth.error });

    const { priceId, waiveConfirmed, idempotencyKey } = req.body || {};

    if (!priceId || !PRICE_MAP[priceId]) {
      return json(res, 400, { error: "Invalid price ID" });
    }

    if (waiveConfirmed !== true) {
      return json(res, 400, {
        error: "You must agree to immediate access and waive cancellation rights."
      });
    }

    const { plan, cycle } = PRICE_MAP[priceId];
    const userId = auth.user.id;
    const userEmail = auth.user.email || undefined;

    const origin = deriveOrigin(req);
    if (!origin) {
      return json(res, 400, { error: "Unable to determine base URL" });
    }

    const key = normalizeIdempotencyKey(idempotencyKey, userId, priceId);

    const { data: existingMap, error: mapErr } = await supabaseAdmin
      .from("billing_customer_map")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (mapErr) {
      console.error("Customer map lookup failed:", mapErr.message);
    }

    const customerId = mapErr ? undefined : (existingMap?.stripe_customer_id || undefined);

    const sessionParams = {
      mode: "subscription",
      payment_method_types: ["card"],
      allow_promotion_codes: true,
      line_items: [{ price: priceId, quantity: 1 }],
      ...(customerId ? { customer: customerId } : { customer_email: userEmail }),
      client_reference_id: userId,
      metadata: {
        plan,
        cycle,
        waive_confirmed: "true",
        user_id: userId
      },
      subscription_data: {
        metadata: {
          plan,
          cycle,
          waive_confirmed: "true",
          user_id: userId
        }
      },
      success_url: `${origin}/subscriptions.html?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/subscriptions.html?canceled=1`
    };

    const session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: key
    });

    return json(res, 200, { url: session.url });
  } catch (err) {
    console.error("Checkout error:", err?.message || "unknown");
    return json(res, 500, { error: "Unable to create checkout session" });
  }
};
