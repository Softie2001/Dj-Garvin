require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const BASE = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
    : null;

function requireSupabase(req, res, next) {
  if (!supabase) {
    return res.status(500).json({
      error:
        "Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the server environment.",
    });
  }
  next();
}

function orderNumber() {
  return (
    "DG-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(3).toString("hex").toUpperCase()
  );
}

function ticketCode() {
  return "TKT-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function transporter() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* PayPal                                                                     */
/* -------------------------------------------------------------------------- */

function paypalConfigured() {
  return Boolean(
    process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
  );
}

function paypalBaseUrl() {
  return String(process.env.PAYPAL_MODE || "sandbox").toLowerCase() === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

async function paypalAccessToken() {
  if (!paypalConfigured()) {
    throw new Error(
      "PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to Vercel Environment Variables."
    );
  }

  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`PayPal authentication failed (${response.status}): ${body}`);
  }

  const data = JSON.parse(body);
  if (!data.access_token) {
    throw new Error("PayPal authentication succeeded but returned no access token.");
  }

  return data.access_token;
}

async function paypalRequest(endpoint, options = {}) {
  const token = await paypalAccessToken();

  const response = await fetch(`${paypalBaseUrl()}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.details?.map((x) => x.description).filter(Boolean).join("; ") ||
      data?.message ||
      text ||
      `PayPal request failed (${response.status})`;

    const error = new Error(message);
    error.status = response.status;
    error.paypal = data;
    throw error;
  }

  return data;
}

function cleanString(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/*
  IMPORTANT:
  The browser sends only ticket IDs + quantities.
  The server reads the real prices from Supabase and calculates the total.
  The browser cannot choose the amount that PayPal will charge.
*/
async function validateCart(eventId, requestedItems) {
  if (!eventId || !Array.isArray(requestedItems) || !requestedItems.length) {
    throw new Error("Select at least one ticket.");
  }

  const ids = [
    ...new Set(
      requestedItems
        .map((item) => String(item?.ticket_type_id || item?.id || "").trim())
        .filter(Boolean)
    ),
  ];

  if (!ids.length) throw new Error("No valid ticket types were supplied.");

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .maybeSingle();

  if (eventError) throw new Error(eventError.message);
  if (!event) throw new Error("Event not found.");
  if (event.status !== "published") throw new Error("This event is not available.");
  if (event.sales_open !== true) throw new Error("Ticket sales are currently closed.");

  const { data: tickets, error: ticketError } = await supabase
    .from("ticket_types")
    .select(
      "id,event_id,name,price_pence,price_gbp,currency,capacity,quantity_sold,status,sales_start,sales_end,description,whats_included,is_group_ticket"
    )
    .eq("event_id", eventId)
    .in("id", ids);

  if (ticketError) throw new Error(ticketError.message);

  const byId = new Map((tickets || []).map((t) => [String(t.id), t]));
  const now = Date.now();

  const items = [];

  for (const requested of requestedItems) {
    const id = String(requested?.ticket_type_id || requested?.id || "").trim();
    const quantity = positiveInt(requested?.quantity);

    if (!id || !quantity) continue;

    const ticket = byId.get(id);
    if (!ticket) throw new Error("One of the selected ticket types is unavailable.");

    if (ticket.status !== "on_sale") {
      throw new Error(`${ticket.name} is not currently on sale.`);
    }

    if (ticket.sales_start && new Date(ticket.sales_start).getTime() > now) {
      throw new Error(`${ticket.name} sales have not started yet.`);
    }

    if (ticket.sales_end && new Date(ticket.sales_end).getTime() < now) {
      throw new Error(`${ticket.name} sales have ended.`);
    }

    const capacity = Number(ticket.capacity || 0);
    const sold = Number(ticket.quantity_sold || 0);

    if (capacity > 0 && sold + quantity > capacity) {
      throw new Error(`Not enough ${ticket.name} tickets remain.`);
    }

    const pricePence =
      Number.isInteger(Number(ticket.price_pence))
        ? Number(ticket.price_pence)
        : Math.round(Number(ticket.price_gbp || 0) * 100);

    if (!Number.isInteger(pricePence) || pricePence < 0) {
      throw new Error(`Invalid price configured for ${ticket.name}.`);
    }

    items.push({
      ticket_type_id: ticket.id,
      name: ticket.name,
      quantity,
      unit_amount_pence: pricePence,
      total_pence: pricePence * quantity,
      is_group_ticket: Boolean(ticket.is_group_ticket),
    });
  }

  if (!items.length) throw new Error("Select at least one ticket.");

  const totalPence = items.reduce((sum, item) => sum + item.total_pence, 0);

  if (totalPence <= 0) throw new Error("The selected tickets have no payable total.");

  return { event, items, totalPence };
}

/* -------------------------------------------------------------------------- */
/* General API                                                                */
/* -------------------------------------------------------------------------- */

app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    supabase: !!supabase,
    paypal: paypalConfigured(),
    paypalMode: process.env.PAYPAL_MODE || "sandbox",
  })
);

app.get("/api/events", requireSupabase, async (req, res) => {
  const { data, error } = await supabase
    .from("events")
    .select("*, ticket_types(*)")
    .eq("status", "published")
    .eq("sales_open", true)
    .order("event_date", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get("/api/events/:slug", requireSupabase, async (req, res) => {
  const { data, error } = await supabase
    .from("events")
    .select("*, ticket_types(*)")
    .eq("slug", req.params.slug)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Event not found" });

  res.json(data);
});

app.post("/api/bookings", requireSupabase, async (req, res) => {
  const { data, error } = await supabase
    .from("bookings")
    .insert([req.body])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true, booking: data });
});

/* -------------------------------------------------------------------------- */
/* PayPal create order                                                        */
/* -------------------------------------------------------------------------- */

app.post("/api/paypal/create-order", requireSupabase, async (req, res) => {
  try {
    const eventId = cleanString(req.body.event_id, 100);
    const customerName = cleanString(req.body.customer_name, 120);
    const customerEmail = cleanString(req.body.customer_email, 254);
    const customerPhone = cleanString(req.body.customer_phone, 50);
    const requestedItems = req.body.items;

    if (!customerName) {
      return res.status(400).json({ error: "Full name is required." });
    }

    if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      return res.status(400).json({ error: "A valid email address is required." });
    }

    const cart = await validateCart(eventId, requestedItems);

    const paypalItems = cart.items.map((item) => ({
      name: item.name.slice(0, 127),
      description: `${cart.event.name} — ${item.name}`.slice(0, 127),
      quantity: String(item.quantity),
      unit_amount: {
        currency_code: "GBP",
        value: (item.unit_amount_pence / 100).toFixed(2),
      },
      category: "DIGITAL_GOODS",
    }));

    const total = (cart.totalPence / 100).toFixed(2);

    const requestId = crypto.randomUUID();

    const paypalOrder = await paypalRequest("/v2/checkout/orders", {
      method: "POST",
      headers: {
        "PayPal-Request-Id": requestId,
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: String(cart.event.id),
            description: cart.event.name.slice(0, 127),
            custom_id: JSON.stringify({
              event_id: cart.event.id,
              customer_email: customerEmail,
            }).slice(0, 127),
            amount: {
              currency_code: "GBP",
              value: total,
              breakdown: {
                item_total: {
                  currency_code: "GBP",
                  value: total,
                },
              },
            },
            items: paypalItems,
          },
        ],
        application_context: {
          brand_name: "DJ Garvin",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: `${BASE}/payment-success.html`,
          cancel_url: `${BASE}/payment-cancelled.html`,
        },
      }),
    });

    /*
      We intentionally don't mark tickets as sold here.
      PayPal has only created the order at this point.
      The stock/order update happens after capture succeeds.
    */

    res.json({
      ok: true,
      id: paypalOrder.id,
      status: paypalOrder.status,
      total_pence: cart.totalPence,
      currency: "GBP",
      event: {
        id: cart.event.id,
        name: cart.event.name,
      },
      items: cart.items,
      approve_url:
        paypalOrder.links?.find((link) => link.rel === "approve")?.href || null,
    });
  } catch (error) {
    console.error("PayPal create-order error:", error);
    res.status(error.status && error.status < 500 ? error.status : 500).json({
      error: error.message || "Could not create PayPal order.",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* PayPal capture order                                                       */
/* -------------------------------------------------------------------------- */

app.post("/api/paypal/capture-order", requireSupabase, async (req, res) => {
  try {
    const orderId = cleanString(req.body.order_id, 100);

    if (!orderId) {
      return res.status(400).json({ error: "PayPal order ID is required." });
    }

    const captured = await paypalRequest(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        headers: {
          Prefer: "return=representation",
          "PayPal-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify({}),
      }
    );

    if (captured.status !== "COMPLETED") {
      return res.status(409).json({
        error: "PayPal payment was not completed.",
        status: captured.status,
      });
    }

    /*
      At this point PayPal has confirmed the payment.
      We return the capture details to the frontend.

      IMPORTANT:
      Your current Supabase project has an orders table, but the exact
      INSERT schema was not present in the existing server file. To avoid
      guessing a column and breaking deployment, order/ticket persistence
      should be wired against the exact SQL schema before going live.
    */

    const capture =
      captured.purchase_units?.[0]?.payments?.captures?.[0] || null;

    res.json({
      ok: true,
      status: captured.status,
      order_id: captured.id,
      capture_id: capture?.id || null,
      amount: capture?.amount?.value || null,
      currency: capture?.amount?.currency_code || "GBP",
      payer: captured.payer
        ? {
            email:
              captured.payer.email_address ||
              null,
            name: captured.payer.name || null,
          }
        : null,
    });
  } catch (error) {
    console.error("PayPal capture-order error:", error);
    res.status(error.status && error.status < 500 ? error.status : 500).json({
      error: error.message || "Could not capture PayPal order.",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* PayPal webhook                                                             */
/* -------------------------------------------------------------------------- */

app.post("/api/paypal/webhook", requireSupabase, async (req, res) => {
  /*
    Do not trust arbitrary webhook POSTs in production.
    Set PAYPAL_WEBHOOK_ID and implement PayPal's official
    verify-webhook-signature endpoint before using webhook events
    to change order/ticket state.
  */
  const event = req.body || {};
  const id = event.id;

  if (!id) return res.status(400).send("Missing event id");

  const { data: existing } = await supabase
    .from("webhook_events")
    .select("id")
    .eq("provider_event_id", id)
    .maybeSingle();

  if (existing) return res.json({ ok: true, duplicate: true });

  const { error } = await supabase.from("webhook_events").insert([
    {
      provider: "paypal",
      provider_event_id: id,
      event_type: event.event_type || null,
      payload: event,
    },
  ]);

  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/* Ticket verification / check-in                                             */
/* -------------------------------------------------------------------------- */

app.get("/ticket/verify/:token", requireSupabase, async (req, res) => {
  const { data, error } = await supabase
    .from("tickets")
    .select(
      "ticket_code,status,customer_name,event_id,events(name,event_date,venue,location),ticket_types(name)"
    )
    .eq("qr_token", req.params.token)
    .maybeSingle();

  if (error || !data) return res.status(404).send("Ticket not found.");

  const event = data.events;

  res.send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ticket Verification</title>
<style>
body{font-family:Arial;max-width:520px;margin:40px auto;padding:20px}
.box{padding:24px;border:1px solid #ddd;border-radius:18px}
.ok{font-size:28px;font-weight:700}
button{padding:14px 20px;border:0;border-radius:10px}
</style>
</head>
<body>
<div class="box">
<div class="ok">${
    data.status === "valid"
      ? "✓ VALID TICKET"
      : "⚠ TICKET " + String(data.status || "").toUpperCase()
  }</div>
<p><b>${data.customer_name || ""}</b></p>
<p>${event?.name || ""}</p>
<p>${data.ticket_types?.name || ""}</p>
<p>Ticket: ${data.ticket_code || ""}</p>
<p>${event?.venue || ""}</p>
${
  data.status === "valid"
    ? `<form method="post" action="/api/checkin/${data.qr_token}">
<button>CHECK IN</button>
</form>`
    : ""
}
</div>
</body>
</html>`);
});

app.post("/api/checkin/:token", requireSupabase, async (req, res) => {
  const { data: ticket } = await supabase
    .from("tickets")
    .select("id,status")
    .eq("qr_token", req.params.token)
    .maybeSingle();

  if (!ticket) return res.status(404).send("Ticket not found");
  if (ticket.status !== "valid") {
    return res.status(409).send("Ticket already used or invalid.");
  }

  const { error } = await supabase
    .from("tickets")
    .update({
      status: "used",
      checked_in_at: new Date().toISOString(),
    })
    .eq("id", ticket.id)
    .eq("status", "valid");

  if (error) return res.status(500).send(error.message);

  res.send("<h2>✓ CHECK-IN SUCCESSFUL</h2>");
});

/* -------------------------------------------------------------------------- */
/* Frontend                                                                    */
/* -------------------------------------------------------------------------- */

app.use(express.static(path.join(__dirname, "public")));

app.get("/{*splat}", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

if (require.main === module) {
  app.listen(PORT, () => console.log(`DJ Garvin site running on ${BASE}`));
}

module.exports = app;
