const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const ALLOWLIST = new Set([
  "price_1T46nyRzC23qaxzMIu41ccnt",
  "price_1T46nyRzC23qaxzM2apXOsNE",
  "price_1T46nyRzC23qaxzMsuQppAj6",
  "price_1T46qbRzC23qaxzM2ebMn3o6",
  "price_1T46qbRzC23qaxzMh15YdWfh",
  "price_1T46qbRzC23qaxzMC9TWNVsK"
]);

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { priceId, plan, cycle } = req.body || {};

    if (!priceId || !ALLOWLIST.has(priceId)) {
      return res.status(400).json({ error: "Invalid priceId" });
    }

    const baseUrl =
      req.headers.origin ||
      (req.headers.host ? `https://${req.headers.host}` : "");

    if (!baseUrl) {
      return res.status(400).json({ error: "Could not determine base URL" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      allow_promotion_codes: true,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        plan: String(plan || ""),
        cycle: String(cycle || "")
      },
      success_url: `${baseUrl}/billing-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/subscriptions.html?canceled=1`
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
};