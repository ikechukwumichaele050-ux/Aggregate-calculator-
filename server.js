/**
 * Minimal backend for gating the Aggregate Calculator behind an OPay payment.
 *
 * Flow:
 *  1. Browser calls POST /api/create-payment  -> we ask OPay to create a payment,
 *     return the checkout URL, browser redirects the buyer there.
 *  2. Buyer pays on OPay's own hosted page.
 *  3. OPay calls POST /api/opay-webhook (server-to-server) to tell us it succeeded.
 *     We verify that call is genuinely from OPay before trusting it.
 *  4. Browser calls GET /api/status/:reference to check "has this been paid for yet?"
 *     and unlocks the calculator if so.
 *
 * IMPORTANT — two spots marked "CONFIRM" below use details OPay's own docs stated
 * inconsistently across pages. Check these against the API reference shown in your
 * own merchant dashboard (Settings -> API Keys & Webhooks -> API docs link) before
 * going live, since a wrong signature check would let anyone fake a "paid" webhook.
 */

const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json());

// Allow your actual website's domain to call this API (update before deploying)
const ALLOWED_ORIGIN = process.env.SITE_ORIGIN || "*";
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST");
  next();
});

const {
  OPAY_PUBLIC_KEY,
  OPAY_SECRET_KEY,
  OPAY_MERCHANT_ID,
  PRICE_NGN,     // amount in Naira, e.g. 1000
  SITE_URL,      // e.g. https://your-domain.com
  PORT,
} = process.env;

// CONFIRM: exact Cashier Create Payment endpoint — check your dashboard's API
// reference; OPay has separate "international" vs regional cashier hosts.
const OPAY_CASHIER_CREATE_URL = "https://liveapi.opaycheckout.com/api/v1/international/cashier/create";

// Simple JSON file as a stand-in "database" of orders. Fine for getting started;
// swap for a real database (Postgres, SQLite, etc.) once you have real volume.
const DB_FILE = "./orders.json";
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return {}; }
}
function saveOrders(orders) {
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2));
}

// ---- 1. Create a payment ----
app.post("/api/create-payment", async (req, res) => {
  try {
    const reference = "AGG-" + crypto.randomBytes(8).toString("hex");
    const amountKobo = Math.round(Number(PRICE_NGN) * 100); // OPay amounts are typically in kobo

    const payload = {
      country: "NG",
      reference,
      amount: { total: amountKobo, currency: "NGN" },
      returnUrl: `${SITE_URL}/?ref=${reference}`,
      callbackUrl: `${SITE_URL}/api/opay-webhook`,
      cancelUrl: `${SITE_URL}/?cancelled=1`,
      product: { name: "Aggregate Calculator — one-time access", description: "Unlocks the calculator for this device" },
    };

    const response = await axios.post(OPAY_CASHIER_CREATE_URL, payload, {
      headers: {
        Authorization: `Bearer ${OPAY_PUBLIC_KEY}`,
        MerchantId: OPAY_MERCHANT_ID,
        "Content-Type": "application/json",
      },
    });

    const orders = loadOrders();
    orders[reference] = { status: "pending", createdAt: Date.now() };
    saveOrders(orders);

    // CONFIRM: field name for the hosted checkout link in OPay's response —
    // commonly `data.cashierUrl`, but verify against your dashboard's sample response.
    const checkoutUrl = response.data?.data?.cashierUrl;
    res.json({ reference, checkoutUrl });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Could not start payment. Please try again." });
  }
});

// ---- 2. OPay calls this when payment succeeds (server-to-server) ----
app.post("/api/opay-webhook", (req, res) => {
  const signatureHeader = req.headers["authorization"]?.replace("Bearer ", "");
  const expected = crypto
    .createHmac("sha512", OPAY_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (!signatureHeader || signatureHeader !== expected) {
    console.warn("Rejected webhook: signature did not match.");
    return res.status(401).send("invalid signature");
  }

  const { reference, status } = req.body?.payload || req.body || {};
  if (reference && status === "SUCCESS") {
    const orders = loadOrders();
    if (orders[reference]) {
      orders[reference].status = "paid";
      orders[reference].paidAt = Date.now();
      saveOrders(orders);
    }
  }
  res.sendStatus(200);
});

// ---- 3. Frontend polls this to check unlock status ----
app.get("/api/status/:reference", (req, res) => {
  const orders = loadOrders();
  const order = orders[req.params.reference];
  res.json({ paid: order?.status === "paid" });
});

app.listen(PORT || 3000, () => console.log(`Payment server running on port ${PORT || 3000}`));
