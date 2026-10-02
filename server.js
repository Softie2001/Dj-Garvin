require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const BASE = String(
  process.env.APP_BASE_URL || `http://localhost:${PORT}`
).replace(/\/+$/, "");

const PAYPAL_MODE = String(
  process.env.PAYPAL_MODE || "sandbox"
).toLowerCase();

const PAYPAL_BASE =
  PAYPAL_MODE === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

const supabase =
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
    : null;

function requireSupabase(req, res, next) {
  if (!supabase) {
    return res.status(500).json({
      error: "Supabase is not configured."
    });
  }

  next();
}

function clean(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
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
  return (
    "TKT-" +
    crypto.randomBytes(5).toString("hex").toUpperCase()
  );
}

function paypalConfigured() {
  return Boolean(
    process.env.PAYPAL_CLIENT_ID &&
    process.env.PAYPAL_CLIENT_SECRET
  );
}

function emailConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

function getMailer() {
  if (!emailConfigured()) return null;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure:
      String(process.env.SMTP_SECURE).toLowerCase() === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function formatEventDate(value) {
  if (!value) return "";

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London"
  }).format(d);
}

function formatEventTime(value) {
  if (!value) return "";

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) return "";

  return new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Europe/London"
  }).format(d);
}

async function paypalToken() {
  if (!paypalConfigured()) {
    throw new Error(
      "PayPal is not configured on the server."
    );
  }

  const basic = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(
    `${PAYPAL_BASE}/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    }
  );

  const text = await response.text();

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(
      data.error_description ||
      data.message ||
      "PayPal authentication failed."
    );
  }

  return data.access_token;
}

async function paypalRequest(url, options = {}) {
  const token = await paypalToken();

  const response = await fetch(
    `${PAYPAL_BASE}${url}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.details
        ?.map((x) => x.description)
        .filter(Boolean)
        .join("; ") ||
      data?.message ||
      data?.raw ||
      `PayPal request failed (${response.status})`;

    const error = new Error(message);
    error.status = response.status;

    throw error;
  }

  return data;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    supabase: Boolean(supabase),
    paypal: paypalConfigured(),
    paypalMode: PAYPAL_MODE,
    email: emailConfigured()
  });
});

app.get(
  "/api/events",
  requireSupabase,
  async (req, res) => {
    const { data, error } = await supabase
      .from("events")
      .select("*, ticket_types(*)")
      .eq("status", "published")
      .eq("sales_open", true)
      .order("event_date", {
        ascending: true
      });

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json(data || []);
  }
);

app.get(
  "/api/events/:key",
  requireSupabase,
  async (req, res) => {
    const key = clean(req.params.key, 200);

    let result = await supabase
      .from("events")
      .select("*, ticket_types(*)")
      .eq("status", "published")
      .eq("sales_open", true)
      .eq("id", key)
      .maybeSingle();

    if (
      result.error &&
      /uuid|invalid input syntax/i.test(
        result.error.message
      )
    ) {
      result = {
        data: null,
        error: null
      };
    }

    if (!result.data) {
      result = await supabase
        .from("events")
        .select("*, ticket_types(*)")
        .eq("status", "published")
        .eq("sales_open", true)
        .eq("slug", key)
        .maybeSingle();
    }

    if (result.error) {
      return res.status(500).json({
        error: result.error.message
      });
    }

    if (!result.data) {
      return res.status(404).json({
        error: "Event not found"
      });
    }

    res.json(result.data);
  }
);

app.post(
  "/api/bookings",
  requireSupabase,
  async (req, res) => {
    const { data, error } = await supabase
      .from("bookings")
      .insert([req.body])
      .select()
      .single();

    if (error) {
      return res.status(400).json({
        error: error.message
      });
    }

    res.json({
      ok: true,
      booking: data
    });
  }
);

async function getCart(eventId, requestedItems) {
  if (
    !eventId ||
    !Array.isArray(requestedItems) ||
    !requestedItems.length
  ) {
    throw new Error(
      "Select at least one ticket."
    );
  }

  const ids = [
    ...new Set(
      requestedItems
        .map(
          (item) =>
            clean(
              item?.ticket_type_id ||
              item?.id,
              100
            )
        )
        .filter(Boolean)
    )
  ];

  const {
    data: event,
    error: eventError
  } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .maybeSingle();

  if (eventError) {
    throw new Error(eventError.message);
  }

  if (!event) {
    throw new Error("Event not found.");
  }

  if (
    event.status !== "published" ||
    event.sales_open !== true
  ) {
    throw new Error(
      "Ticket sales are currently closed."
    );
  }

  const {
    data: tickets,
    error
  } = await supabase
    .from("ticket_types")
    .select(
      "id,event_id,name,price_gbp,price_pence,currency,capacity,quantity_sold,status,sales_start,sales_end,description,whats_included,is_group_ticket"
    )
    .eq("event_id", eventId)
    .in("id", ids);

  if (error) {
    throw new Error(error.message);
  }

  const map = new Map(
    (tickets || []).map((ticket) => [
      String(ticket.id),
      ticket
    ])
  );

  const now = Date.now();
  const items = [];

  for (const requested of requestedItems) {
    const id = clean(
      requested?.ticket_type_id ||
      requested?.id,
      100
    );

    const quantity = positiveInt(
      requested?.quantity
    );

    if (!id || !quantity) continue;

    const ticket = map.get(id);

    if (!ticket) {
      throw new Error(
        "One of the selected tickets is unavailable."
      );
    }

    if (!["on_sale"].includes(ticket.status)) {
      throw new Error(
        `${ticket.name} is not currently on sale.`
      );
    }

    if (
      ticket.sales_start &&
      new Date(ticket.sales_start).getTime() >
        now
    ) {
      throw new Error(
        `${ticket.name} sales have not started yet.`
      );
    }

    if (
      ticket.sales_end &&
      new Date(ticket.sales_end).getTime() <
        now
    ) {
      throw new Error(
        `${ticket.name} sales have ended.`
      );
    }

    const capacity = Number(
      ticket.capacity || 0
    );

    const sold = Number(
      ticket.quantity_sold || 0
    );

    if (
      capacity > 0 &&
      sold + quantity > capacity
    ) {
      throw new Error(
        `Not enough ${ticket.name} tickets remain.`
      );
    }

    const pricePence =
      Number.isFinite(
        Number(ticket.price_pence)
      ) &&
      Number(ticket.price_pence) >= 0
        ? Number(ticket.price_pence)
        : Math.round(
            Number(ticket.price_gbp || 0) * 100
          );

    if (
      !Number.isInteger(pricePence) ||
      pricePence < 0
    ) {
      throw new Error(
        `Invalid price configured for ${ticket.name}.`
      );
    }

    items.push({
      ticket_type_id: ticket.id,
      name: ticket.name,
      quantity,
      unit_price_pence: pricePence,
      total_pence:
        pricePence * quantity,
      is_group_ticket:
        Boolean(ticket.is_group_ticket)
    });
  }

  if (!items.length) {
    throw new Error(
      "Select at least one ticket."
    );
  }

  const totalPence = items.reduce(
    (sum, item) =>
      sum + item.total_pence,
    0
  );

  if (totalPence <= 0) {
    throw new Error(
      "The selected tickets have no payable total."
    );
  }

  return {
    event,
    items,
    totalPence
  };
}

app.post(
  "/api/paypal/create-order",
  requireSupabase,
  async (req, res) => {
    try {
      const eventId = clean(
        req.body.event_id,
        100
      );

      const firstName = clean(
        req.body.first_name,
        80
      );

      const lastName = clean(
        req.body.last_name,
        80
      );

      const email = clean(
        req.body.email,
        254
      );

      const phone = clean(
        req.body.phone,
        50
      );

      if (
        !firstName ||
        !lastName ||
        !email ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          email
        )
      ) {
        return res.status(400).json({
          error:
            "Enter your first name, last name and a valid email."
        });
      }

      const cart = await getCart(
        eventId,
        req.body.items
      );

      const total =
        (cart.totalPence / 100).toFixed(2);

      const paypalOrder =
        await paypalRequest(
          "/v2/checkout/orders",
          {
            method: "POST",

            headers: {
              "PayPal-Request-Id":
                crypto.randomUUID(),

              Prefer:
                "return=representation"
            },

            body: JSON.stringify({
              intent: "CAPTURE",

              purchase_units: [
                {
                  reference_id:
                    String(
                      cart.event.id
                    ),

                  description:
                    String(
                      cart.event.name ||
                      "DJ Garvin Event"
                    ).slice(0, 127),

                  custom_id: eventId,

                  amount: {
                    currency_code: "GBP",

                    value: total,

                    breakdown: {
                      item_total: {
                        currency_code: "GBP",
                        value: total
                      }
                    }
                  },

                  items: cart.items.map(
                    (item) => ({
                      name:
                        item.name.slice(
                          0,
                          127
                        ),

                      quantity:
                        String(
                          item.quantity
                        ),

                      unit_amount: {
                        currency_code:
                          "GBP",

                        value:
                          (
                            item.unit_price_pence /
                            100
                          ).toFixed(2)
                      },

                      category:
                        "DIGITAL_GOODS"
                    })
                  )
                }
              ],

              application_context: {
                brand_name:
                  "DJ Garvin",

                user_action:
                  "PAY_NOW",

                shipping_preference:
                  "NO_SHIPPING",

                return_url:
                  `${BASE}/payment-success.html`,

                cancel_url:
                  `${BASE}/payment-cancelled.html`
              }
            })
          }
        );

      const {
        data: order,
        error: orderError
      } = await supabase
        .from("orders")
        .insert([
          {
            order_number:
              orderNumber(),

            event_id:
              cart.event.id,

            customer_first_name:
              firstName,

            customer_last_name:
              lastName,

            customer_email:
              email,

            customer_phone:
              phone || null,

            currency:
              "GBP",

            total_gbp:
              total,

            status:
              "pending",

            paypal_order_id:
              paypalOrder.id
          }
        ])
        .select()
        .single();

      if (orderError) {
        throw new Error(
          orderError.message
        );
      }

      const {
        error: itemError
      } = await supabase
        .from("order_items")
        .insert(
          cart.items.map(
            (item) => ({
              order_id:
                order.id,

              ticket_type_id:
                item.ticket_type_id,

              quantity:
                item.quantity,

              unit_price_gbp:
                (
                  item.unit_price_pence /
                  100
                ).toFixed(2)
            })
          )
        );

      if (itemError) {
        await supabase
          .from("orders")
          .delete()
          .eq("id", order.id);

        throw new Error(
          itemError.message
        );
      }

      const approvalUrl =
        paypalOrder.links?.find(
          (link) =>
            link.rel === "approve"
        )?.href ||
        paypalOrder.links?.find(
          (link) =>
            link.rel === "payer-action"
        )?.href ||
        null;

      res.json({
        ok: true,
        id: paypalOrder.id,
        approval_url:
          approvalUrl,
        order_id:
          order.id,
        order_number:
          order.order_number,
        total_gbp:
          total,
        currency:
          "GBP"
      });
    } catch (error) {
      console.error(
        "create-order",
        error
      );

      res.status(
        error.status &&
        error.status < 500
          ? error.status
          : 500
      ).json({
        error:
          error.message ||
          "Could not create PayPal order."
      });
    }
  }
);

async function getOrderTickets(
  orderId
) {
  const {
    data,
    error
  } = await supabase
    .from("tickets")
    .select(
      "id,ticket_code,qr_token,customer_name,status,event_id,ticket_type_id,created_at,ticket_types(name),events(name,event_date,venue,location)"
    )
    .eq(
      "order_id",
      orderId
    )
    .order(
      "created_at",
      {
        ascending: true
      }
    );

  if (error) {
    throw new Error(
      error.message
    );
  }

  return data || [];
}

async function createMissingTickets(
  dbOrder
) {
  const {
    data: items,
    error: itemError
  } = await supabase
    .from("order_items")
    .select("*")
    .eq(
      "order_id",
      dbOrder.id
    );

  if (itemError) {
    throw new Error(
      itemError.message
    );
  }

  for (const item of items || []) {
    const {
      data: ticketType,
      error
    } = await supabase
      .from("ticket_types")
      .select(
        "id,name,event_id,capacity,quantity_sold,status"
      )
      .eq(
        "id",
        item.ticket_type_id
      )
      .maybeSingle();

    if (error || !ticketType) {
      throw new Error(
        error?.message ||
        "Ticket type not found."
      );
    }

    const {
      count,
      error: countError
    } = await supabase
      .from("tickets")
      .select(
        "id",
        {
          count: "exact",
          head: true
        }
      )
      .eq(
        "order_item_id",
        item.id
      );

    if (countError) {
      throw new Error(
        countError.message
      );
    }

    const existingCount =
      Number(count || 0);

    const needed =
      Math.max(
        0,
        Number(item.quantity) -
          existingCount
      );

    if (needed <= 0) continue;

    const capacity =
      Number(
        ticketType.capacity || 0
      );

    const sold =
      Number(
        ticketType.quantity_sold ||
        0
      );

    if (
      capacity > 0 &&
      sold + needed >
        capacity
    ) {
      throw new Error(
        `Not enough ${ticketType.name} tickets remain.`
      );
    }

    const ticketRows = [];

    for (
      let i = 0;
      i < needed;
      i++
    ) {
      ticketRows.push({
        order_id:
          dbOrder.id,

        order_item_id:
          item.id,

        ticket_type_id:
          ticketType.id,

        event_id:
          dbOrder.event_id,

        ticket_code:
          ticketCode(),

        qr_token:
          crypto
            .randomBytes(24)
            .toString("hex"),

        customer_name:
          `${dbOrder.customer_first_name} ${dbOrder.customer_last_name}`.trim(),

        status:
          "valid"
      });
    }

    const {
      error: ticketError
    } = await supabase
      .from("tickets")
      .insert(
        ticketRows
      );

    if (ticketError) {
      throw new Error(
        ticketError.message
      );
    }

    const newSold =
      sold + needed;

    const newStatus =
      capacity > 0 &&
      newSold >= capacity
        ? "sold_out"
        : ticketType.status;

    const {
      error: soldError
    } = await supabase
      .from("ticket_types")
      .update({
        quantity_sold:
          newSold,

        status:
          newStatus
      })
      .eq(
        "id",
        ticketType.id
      );

    if (soldError) {
      throw new Error(
        soldError.message
      );
    }
  }

  return getOrderTickets(
    dbOrder.id
  );
}

async function sendTicketEmail(
  order,
  tickets
) {
  if (!tickets.length) {
    return {
      sent: false,
      skipped: true,
      reason:
        "No tickets were generated."
    };
  }

  const mailer =
    getMailer();

  if (!mailer) {
    console.error(
      "Ticket email not sent: SMTP_HOST, SMTP_USER or SMTP_PASS is missing."
    );

    return {
      sent: false,
      skipped: true,
      reason:
        "SMTP is not configured."
    };
  }

  const firstTicket =
    tickets[0];

  const event =
    firstTicket.events ||
    {};

  const ticketCards = [];
  const attachments = [];

  for (
    let index = 0;
    index < tickets.length;
    index++
  ) {
    const ticket =
      tickets[index];

    const verificationUrl =
      `${BASE}/ticket/verify/${encodeURIComponent(ticket.qr_token)}`;

    const qrDataUrl =
      await QRCode.toDataURL(
        verificationUrl,
        {
          errorCorrectionLevel:
            "M",

          margin: 2,

          width: 420
        }
      );

    const base64 =
      qrDataUrl.replace(
        /^data:image\/png;base64,/,
        ""
      );

    const cid =
      `djgarvin-qr-${index}-${ticket.id}@djgarvin`;

    attachments.push({
      filename:
        `${ticket.ticket_code}.png`,

      content:
        Buffer.from(
          base64,
          "base64"
        ),

      contentType:
        "image/png",

      cid
    });

    ticketCards.push(`
      <div style="
        border:1px solid #e6e6e6;
        border-radius:18px;
        padding:22px;
        margin:0 0 18px;
        background:#ffffff;
      ">
        <h3 style="margin:0 0 10px;color:#111;">
          ${escapeHtml(
            ticket.ticket_types?.name ||
            "Event Ticket"
          )}
        </h3>

        <p style="margin:5px 0;color:#555;">
          <strong>Ticket:</strong>
          ${escapeHtml(
            ticket.ticket_code
          )}
        </p>

        <p style="margin:5px 0;color:#555;">
          <strong>Guest:</strong>
          ${escapeHtml(
            ticket.customer_name
          )}
        </p>

        <div style="
          text-align:center;
          margin:22px 0 10px;
        ">
          <img
            src="cid:${cid}"
            alt="DJ Garvin ticket QR code"
            width="300"
            style="
              display:block;
              margin:auto;
              max-width:100%;
              height:auto;
            "
          >
        </div>

        <p style="
          text-align:center;
          margin:8px 0 0;
          color:#777;
          font-size:13px;
        ">
          Present this QR code at the event entrance.
        </p>
      </div>
    `);
  }

  const eventDate =
    formatEventDate(
      event.event_date
    );

  const eventTime =
    formatEventTime(
      event.event_date
    );

  const fromAddress =
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    "DJ Garvin";

  const subject =
    `Your DJ Garvin ticket${tickets.length > 1 ? "s" : ""} — ${event.name || "Event"}`;

  const html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(
    subject
  )}</title>
</head>

<body style="
  margin:0;
  padding:0;
  background:#f4f4f4;
  font-family:Arial,Helvetica,sans-serif;
  color:#171717;
">
  <div style="
    max-width:680px;
    margin:0 auto;
    padding:30px 16px;
  ">

    <div style="
      background:#0b0b0b;
      color:#ffffff;
      border-radius:22px 22px 0 0;
      padding:28px;
      text-align:center;
    ">
      <div style="
        color:#e7b96d;
        font-size:13px;
        letter-spacing:3px;
        font-weight:700;
      ">
        DJ GARVIN
      </div>

      <h1 style="
        margin:12px 0 0;
        font-size:28px;
      ">
        Your Ticket${tickets.length > 1 ? "s" : ""}
      </h1>
    </div>

    <div style="
      background:#ffffff;
      padding:28px;
      border-radius:0 0 22px 22px;
    ">

      <p style="font-size:17px;">
        Hello ${escapeHtml(
          order.customer_first_name
        )},
      </p>

      <p style="
        color:#555;
        line-height:1.7;
      ">
        Thank you for your purchase.
        Your DJ Garvin event ticket
        ${tickets.length > 1 ? "details are" : "is"}
        below.
      </p>

      <div style="
        background:#fafafa;
        border:1px solid #e8e8e8;
        border-radius:16px;
        padding:18px;
        margin:20px 0;
      ">
        <h2 style="margin:0 0 12px;">
          ${escapeHtml(
            event.name ||
            "DJ Garvin Event"
          )}
        </h2>

        ${
          eventDate
            ? `<p style="margin:6px 0;color:#555;"><strong>Date:</strong> ${escapeHtml(eventDate)}</p>`
            : ""
        }

        ${
          eventTime
            ? `<p style="margin:6px 0;color:#555;"><strong>Time:</strong> ${escapeHtml(eventTime)}</p>`
            : ""
        }

        ${
          event.venue
            ? `<p style="margin:6px 0;color:#555;"><strong>Venue:</strong> ${escapeHtml(event.venue)}</p>`
            : ""
        }

        ${
          event.location
            ? `<p style="margin:6px 0;color:#555;"><strong>Location:</strong> ${escapeHtml(event.location)}</p>`
            : ""
        }

        <p style="
          margin:12px 0 0;
          color:#555;
        ">
          <strong>Order:</strong>
          ${escapeHtml(
            order.order_number
          )}
        </p>

        <p style="
          margin:6px 0 0;
          color:#555;
        ">
          <strong>Total paid:</strong>
          £${Number(
            order.total_gbp
          ).toFixed(2)}
        </p>
      </div>

      ${ticketCards.join("")}

      <p style="
        color:#777;
        font-size:13px;
        line-height:1.6;
        margin-top:25px;
      ">
        Keep this email and your QR code
        available for entry. Each ticket
        has its own unique QR code.
      </p>

      <p style="margin-top:28px;">
        Thank you,<br>
        <strong>DJ Garvin</strong>
      </p>

    </div>
  </div>
</body>
</html>
`;

  const text = [
    `DJ Garvin Ticket`,
    ``,
    `Hello ${order.customer_first_name},`,
    ``,
    `Your payment was successful.`,
    `Event: ${
      event.name ||
      "DJ Garvin Event"
    }`,
    eventDate
      ? `Date: ${eventDate}`
      : "",
    eventTime
      ? `Time: ${eventTime}`
      : "",
    event.venue
      ? `Venue: ${event.venue}`
      : "",
    event.location
      ? `Location: ${event.location}`
      : "",
    `Order: ${order.order_number}`,
    `Total paid: £${Number(
      order.total_gbp
    ).toFixed(2)}`,
    ``,
    ...tickets.map(
      (ticket) =>
        `${ticket.ticket_types?.name || "Ticket"} — ${ticket.ticket_code}`
    ),
    ``,
    `Your QR code(s) are included in this email.`
  ]
    .filter(Boolean)
    .join("\n");

  await mailer.sendMail({
    from:
      fromAddress,

    to:
      order.customer_email,

    subject,

    text,

    html,

    attachments
  });

  return {
    sent: true,
    skipped: false
  };
}

async function markEmailSent(
  orderId,
  emailResult
) {
  if (!emailResult?.sent)
    return;

  const {
    data: payment
  } = await supabase
    .from("payments")
    .select(
      "id,raw_event"
    )
    .eq(
      "order_id",
      orderId
    )
    .maybeSingle();

  if (!payment) return;

  const rawEvent =
    payment.raw_event &&
    typeof payment.raw_event ===
      "object"
      ? payment.raw_event
      : {};

  rawEvent.ticket_email_sent_at =
    new Date().toISOString();

  await supabase
    .from("payments")
    .update({
      raw_event:
        rawEvent
    })
    .eq(
      "id",
      payment.id
    );
}

async function isTicketEmailAlreadySent(
  orderId
) {
  const {
    data: payment
  } = await supabase
    .from("payments")
    .select("raw_event")
    .eq(
      "order_id",
      orderId
    )
    .maybeSingle();

  return Boolean(
    payment?.raw_event &&
    typeof payment.raw_event ===
      "object" &&
    payment.raw_event
      .ticket_email_sent_at
  );
}

async function finalizePaidOrder(
  dbOrder,
  captured
) {
  const capture =
    captured
      .purchase_units?.[0]
      ?.payments
      ?.captures?.[0];

  if (!capture?.id) {
    throw new Error(
      "PayPal returned no capture details."
    );
  }

  const paidAmount =
    Number(
      capture.amount?.value
    );

  if (
    capture.amount?.currency_code !==
      "GBP" ||
    Math.abs(
      paidAmount -
      Number(
        dbOrder.total_gbp
      )
    ) > 0.01
  ) {
    throw new Error(
      "PayPal payment amount does not match the booking total."
    );
  }

  if (
    dbOrder.status !==
    "paid"
  ) {
    const {
      data: updated,
      error: updateError
    } = await supabase
      .from("orders")
      .update({
        status:
          "paid",

        paypal_capture_id:
          capture.id,

        paid_at:
          new Date().toISOString()
      })
      .eq(
        "id",
        dbOrder.id
      )
      .in(
        "status",
        ["pending"]
      )
      .select()
      .maybeSingle();

    if (updateError) {
      throw new Error(
        updateError.message
      );
    }

    if (!updated) {
      const {
        data: currentOrder
      } = await supabase
        .from("orders")
        .select("*")
        .eq(
          "id",
          dbOrder.id
        )
        .maybeSingle();

      if (currentOrder) {
        dbOrder =
          currentOrder;
      }
    } else {
      dbOrder =
        updated;
    }
  }

  const {
    data: existingPayment,
    error:
      paymentLookupError
  } = await supabase
    .from("payments")
    .select("id")
    .eq(
      "order_id",
      dbOrder.id
    )
    .maybeSingle();

  if (paymentLookupError) {
    throw new Error(
      paymentLookupError.message
    );
  }

  if (!existingPayment) {
    const {
      error
    } = await supabase
      .from("payments")
      .insert([
        {
          order_id:
            dbOrder.id,

          provider:
            "paypal",

          provider_order_id:
            dbOrder.paypal_order_id,

          provider_capture_id:
            capture.id,

          amount_gbp:
            paidAmount.toFixed(2),

          status:
            "completed",

          raw_event:
            captured
        }
      ]);

    if (error) {
      throw new Error(
        error.message
      );
    }
  }

  const tickets =
    await createMissingTickets(
      dbOrder
    );

  return {
    order:
      dbOrder,

    tickets
  };
}

async function emailPaidOrder(
  order,
  tickets
) {
  if (!tickets.length) {
    return {
      sent: false,
      skipped: true,
      reason:
        "No tickets were generated."
    };
  }

  const alreadySent =
    await isTicketEmailAlreadySent(
      order.id
    );

  if (alreadySent) {
    return {
      sent: false,
      skipped: true,
      reason:
        "Ticket email already sent."
    };
  }

  try {
    const result =
      await sendTicketEmail(
        order,
        tickets
      );

    if (result.sent) {
      await markEmailSent(
        order.id,
        result
      );
    }

    return result;
  } catch (error) {
    console.error(
      "ticket-email",
      error
    );

    return {
      sent: false,
      skipped: false,
      reason:
        error.message ||
        "Ticket email could not be sent."
    };
  }
}

app.post(
  "/api/paypal/capture-order",
  requireSupabase,
  async (req, res) => {
    try {
      const paypalId =
        clean(
          req.body.order_id,
          100
        );

      if (!paypalId) {
        return res.status(400).json({
          error:
            "PayPal order ID is required."
        });
      }

      const {
        data: dbOrder,
        error
      } = await supabase
        .from("orders")
        .select("*")
        .eq(
          "paypal_order_id",
          paypalId
        )
        .maybeSingle();

      if (error) {
        throw new Error(
          error.message
        );
      }

      if (!dbOrder) {
        return res.status(404).json({
          error:
            "Booking order not found."
        });
      }

      let paidOrder =
        dbOrder;

      let tickets;

      if (
        dbOrder.status !==
        "paid"
      ) {
        const captured =
          await paypalRequest(
            `/v2/checkout/orders/${encodeURIComponent(paypalId)}/capture`,
            {
              method:
                "POST",

              headers: {
                "PayPal-Request-Id":
                  crypto.randomUUID(),

                Prefer:
                  "return=representation"
              },

              body:
                JSON.stringify({})
            }
          );

        if (
          captured.status !==
          "COMPLETED"
        ) {
          return res.status(409).json({
            error:
              "PayPal payment was not completed.",

            status:
              captured.status
          });
        }

        const finalized =
          await finalizePaidOrder(
            dbOrder,
            captured
          );

        paidOrder =
          finalized.order;

        tickets =
          finalized.tickets;
      } else {
        tickets =
          await createMissingTickets(
            dbOrder
          );
      }

      const email =
        await emailPaidOrder(
          paidOrder,
          tickets
        );

      const {
        data: finalOrder
      } = await supabase
        .from("orders")
        .select(
          "id,order_number,event_id,customer_first_name,customer_last_name,customer_email,total_gbp,currency,status,paid_at,paypal_capture_id"
        )
        .eq(
          "id",
          paidOrder.id
        )
        .single();

      const finalTickets =
        await getOrderTickets(
          paidOrder.id
        );

      res.json({
        ok: true,

        order:
          finalOrder,

        tickets:
          finalTickets,

        email: {
          sent:
            email.sent,

          skipped:
            email.skipped,

          message:
            email.reason ||
            "Ticket email sent."
        }
      });
    } catch (error) {
      console.error(
        "capture-order",
        error
      );

      res.status(
        error.status &&
        error.status < 500
          ? error.status
          : 500
      ).json({
        error:
          error.message ||
          "Could not capture PayPal order."
      });
    }
  }
);

app.get(
  "/api/orders/:orderNumber",
  requireSupabase,
  async (req, res) => {
    const {
      data: order,
      error
    } = await supabase
      .from("orders")
      .select(
        "id,order_number,event_id,customer_first_name,customer_last_name,customer_email,total_gbp,currency,status,paid_at"
      )
      .eq(
        "order_number",
        req.params.orderNumber
      )
      .maybeSingle();

    if (error) {
      return res.status(500).json({
        error:
          error.message
      });
    }

    if (!order) {
      return res.status(404).json({
        error:
          "Order not found"
      });
    }

    const tickets =
      await getOrderTickets(
        order.id
      );

    res.json({
      order,
      tickets
    });
  }
);

/*
  QR scanner endpoint.

  The existing checkin.html calls:
  /api/tickets/verify?token=...

  This route intentionally returns JSON in the exact shape
  expected by the scanner.
*/

app.get(
  "/api/tickets/verify",
  requireSupabase,
  async (req, res) => {
    const token =
      clean(
        req.query.token ||
        req.query.qr_token,
        500
      );

    if (!token) {
      return res.status(400).json({
        valid: false,
        message:
          "No ticket QR code was provided."
      });
    }

    const {
      data,
      error
    } = await supabase
      .from("tickets")
      .select(
        "id,ticket_code,status,customer_name,event_id,qr_token,ticket_types(name),events(name,event_date,venue,location)"
      )
      .eq(
        "qr_token",
        token
      )
      .maybeSingle();

    if (error) {
      console.error(
        "ticket-verify",
        error
      );

      return res.status(500).json({
        valid: false,
        message:
          "Ticket verification service is unavailable."
      });
    }

    if (!data) {
      return res.status(404).json({
        valid: false,
        message:
          "Ticket not found."
      });
    }

    if (
      data.status !==
      "valid"
    ) {
      const statusMessage =
        data.status ===
        "used"
          ? "This ticket has already been used."
          : `This ticket is ${data.status}.`;

      return res.status(409).json({
        valid: false,
        message:
          statusMessage,

        ticket_ref:
          data.ticket_code,

        customer_name:
          data.customer_name,

        event_name:
          data.events?.name ||
          "",

        ticket_type:
          data.ticket_types?.name ||
          ""
      });
    }

    return res.json({
      valid: true,

      ticket_ref:
        data.ticket_code,

      customer_name:
        data.customer_name,

      event_name:
        data.events?.name ||
        "",

      ticket_type:
        data.ticket_types?.name ||
        "",

      event_date:
        data.events?.event_date ||
        null,

      venue:
        data.events?.venue ||
        "",

      location:
        data.events?.location ||
        "",

      status:
        data.status
    });
  }
);

/*
  QR codes in customer emails open this human-readable verification page.
  The staff scanner can also scan this URL because checkin.html extracts
  the token from /ticket/verify/:token.
*/

app.get(
  "/ticket/verify/:token",
  requireSupabase,
  async (req, res) => {
    const token =
      clean(
        req.params.token,
        500
      );

    const {
      data,
      error
    } = await supabase
      .from("tickets")
      .select(
        "ticket_code,status,customer_name,event_id,events(name,event_date,venue,location),ticket_types(name)"
      )
      .eq(
        "qr_token",
        token
      )
      .maybeSingle();

    if (
      error ||
      !data
    ) {
      return res
        .status(404)
        .send(
          "Ticket not found."
        );
    }

    const event =
      data.events ||
      {};

    const ticketType =
      data.ticket_types ||
      {};

    res.send(`
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DJ Garvin Ticket</title>

<style>
body{
  margin:0;
  background:#090909;
  color:#f5f2ed;
  font-family:Arial,Helvetica,sans-serif;
}

.box{
  max-width:520px;
  margin:40px auto;
  padding:28px;
}

.card{
  background:#151515;
  border:1px solid rgba(255,255,255,.12);
  border-radius:22px;
  padding:26px;
}

.gold{
  color:#e7b96d;
}

.ok{
  font-size:28px;
  font-weight:800;
}

.muted{
  color:#aaa59d;
  line-height:1.6;
}
</style>

</head>

<body>

<div class="box">

  <div class="card">

    <div
      class="gold"
      style="
        font-size:13px;
        letter-spacing:3px;
        font-weight:700;
      "
    >
      DJ GARVIN
    </div>

    <div
      class="ok"
      style="margin-top:14px;"
    >
      ${
        data.status ===
        "valid"
          ? "✓ VALID TICKET"
          : "⚠ TICKET " +
            escapeHtml(
              data.status
            ).toUpperCase()
      }
    </div>

    <p>
      <strong>
        ${escapeHtml(
          data.customer_name
        )}
      </strong>
    </p>

    <p>
      ${escapeHtml(
        event.name || ""
      )}
    </p>

    <p>
      ${escapeHtml(
        ticketType.name ||
        ""
      )}
    </p>

    <p>
      Ticket:
      ${escapeHtml(
        data.ticket_code
      )}
    </p>

    ${
      event.event_date
        ? `<p>
            ${escapeHtml(
              formatEventDate(
                event.event_date
              )
            )}
            ${
              formatEventTime(
                event.event_date
              )
                ? ` • ${escapeHtml(
                    formatEventTime(
                      event.event_date
                    )
                  )}`
                : ""
            }
          </p>`
        : ""
    }

    ${
      event.venue
        ? `<p>
            ${escapeHtml(
              event.venue
            )}
          </p>`
        : ""
    }

    ${
      event.location
        ? `<p>
            ${escapeHtml(
              event.location
            )}
          </p>`
        : ""
    }

    <p class="muted">
      ${
        data.status ===
        "valid"
          ? "Present this ticket at the event entrance."
          : "This ticket cannot be used for entry."
      }
    </p>

  </div>

</div>

</body>
</html>
`);
  }
);

app.post(
  "/api/checkin/:token",
  requireSupabase,
  async (req, res) => {
    const token =
      clean(
        req.params.token,
        500
      );

    if (!token) {
      return res
        .status(400)
        .send(
          "Ticket token is required."
        );
    }

    const {
      data: ticket,
      error: findError
    } = await supabase
      .from("tickets")
      .select(
        "id,status,customer_name,ticket_code"
      )
      .eq(
        "qr_token",
        token
      )
      .maybeSingle();

    if (findError) {
      return res
        .status(500)
        .send(
          findError.message
        );
    }

    if (!ticket) {
      return res
        .status(404)
        .send(
          "Ticket not found."
        );
    }

    if (
      ticket.status !==
      "valid"
    ) {
      return res
        .status(409)
        .send(
          ticket.status ===
          "used"
            ? "Ticket has already been used."
            : "Ticket is already invalid."
        );
    }

    const {
      data: updated,
      error: updateError
    } = await supabase
      .from("tickets")
      .update({
        status:
          "used",

        checked_in_at:
          new Date().toISOString()
      })
      .eq(
        "id",
        ticket.id
      )
      .eq(
        "status",
        "valid"
      )
      .select(
        "id,status,customer_name,ticket_code"
      )
      .maybeSingle();

    if (updateError) {
      return res
        .status(500)
        .send(
          updateError.message
        );
    }

    if (!updated) {
      return res
        .status(409)
        .send(
          "Ticket could not be checked in."
        );
    }

    res.send(
      "✓ CHECK-IN SUCCESSFUL"
    );
  }
);

app.post(
  "/api/paypal/webhook",
  requireSupabase,
  async (req, res) => {
    const event =
      req.body || {};

    if (!event.id) {
      return res
        .status(400)
        .send(
          "Missing event id"
        );
    }

    const {
      data: existing
    } = await supabase
      .from("webhook_events")
      .select("id")
      .eq(
        "provider_event_id",
        event.id
      )
      .maybeSingle();

    if (existing) {
      return res.json({
        ok: true,
        duplicate: true
      });
    }

    const {
      error
    } = await supabase
      .from("webhook_events")
      .insert([
        {
          provider:
            "paypal",

          provider_event_id:
            event.id,

          event_type:
            event.event_type,

          payload:
            event
        }
      ]);

    if (error) {
      return res.status(500).json({
        error:
          error.message
      });
    }

    res.json({
      ok: true
    });
  }
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

app.get(
  "/{*splat}",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

if (
  require.main ===
  module
) {
  app.listen(
    PORT,
    () => {
      console.log(
        `DJ Garvin site running on ${BASE}`
      );
    }
  );
}

module.exports = app;
