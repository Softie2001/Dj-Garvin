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
const BASE = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function requireSupabase(req, res, next) {
  if (!supabase) return res.status(500).json({ error: "Supabase is not configured. Copy .env.example to .env and add credentials." });
  next();
}

function orderNumber() {
  return "DG-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
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
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

app.get("/api/health", (req,res)=>res.json({ok:true, supabase:!!supabase}));

app.get("/api/events", requireSupabase, async (req,res)=>{
  const { data, error } = await supabase.from("events").select("*, ticket_types(*)").eq("status","published").eq("sales_open",true).order("event_date",{ascending:true});
  if(error) return res.status(500).json({error:error.message});
  res.json(data);
});



// Daily Vercel Cron: remove flyers from events that have been closed for 30+ days.
// The event, tickets, orders and check-in history are kept; only the stored flyer is removed.
app.get("/api/cleanup-event-flyers", requireSupabase, async (req,res)=>{
  const auth = req.headers.authorization || "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({error:"Unauthorized"});
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: events, error } = await supabase
    .from("events")
    .select("id,image_url,closed_at")
    .eq("status","closed")
    .not("image_url","is",null)
    .not("closed_at","is",null)
    .lte("closed_at", cutoff);

  if (error) return res.status(500).json({error:error.message});

  let removed = 0;
  const failures = [];
  for (const event of (events || [])) {
    try {
      const marker = "/storage/v1/object/public/event-flyers/";
      const index = String(event.image_url || "").indexOf(marker);
      if (index === -1) {
        failures.push({id:event.id, error:"Flyer URL is not from the event-flyers bucket"});
        continue;
      }
      const filePath = decodeURIComponent(String(event.image_url).slice(index + marker.length));
      if (!filePath) {
        failures.push({id:event.id, error:"Could not determine flyer path"});
        continue;
      }

      const { error: removeError } = await supabase.storage.from("event-flyers").remove([filePath]);
      if (removeError) {
        failures.push({id:event.id, error:removeError.message});
        continue;
      }

      const { error: updateError } = await supabase
        .from("events")
        .update({image_url:null})
        .eq("id",event.id);
      if (updateError) {
        failures.push({id:event.id, error:updateError.message});
        continue;
      }
      removed++;
    } catch (err) {
      failures.push({id:event.id, error:err?.message || String(err)});
    }
  }

  res.json({ok:true, checked:(events||[]).length, removed, failures});
});

app.get("/api/events/:slug", requireSupabase, async (req,res)=>{
  const { data, error } = await supabase.from("events").select("*, ticket_types(*)").eq("slug",req.params.slug).maybeSingle();
  if(error) return res.status(500).json({error:error.message});
  if(!data) return res.status(404).json({error:"Event not found"});
  res.json(data);
});

app.post("/api/bookings", requireSupabase, async (req,res)=>{
  const { data, error } = await supabase.from("bookings").insert([req.body]).select().single();
  if(error) return res.status(400).json({error:error.message});
  res.json({ok:true, booking:data});
});

app.post("/api/paypal/webhook", requireSupabase, async (req,res)=>{
  // Production note: configure PAYPAL_WEBHOOK_ID and implement PayPal's
  // official verify-webhook-signature API call before trusting events.
  const event = req.body || {};
  const id = event.id;
  if(!id) return res.status(400).send("Missing event id");
  const { data: existing } = await supabase.from("webhook_events").select("id").eq("provider_event_id",id).maybeSingle();
  if(existing) return res.json({ok:true, duplicate:true});
  await supabase.from("webhook_events").insert([{provider:"paypal",provider_event_id:id,event_type:event.event_type,payload:event}]);
  res.json({ok:true});
});

app.post("/api/paypal/create-order", requireSupabase, async (req,res)=>{
  return res.status(501).json({error:"PayPal credentials are not configured in this starter. Add them to .env, then implement/enable the PayPal Orders API flow."});
});

app.post("/api/paypal/capture-order", requireSupabase, async (req,res)=>{
  return res.status(501).json({error:"PayPal capture is intentionally disabled until live/sandbox credentials are configured."});
});

app.get("/ticket/verify/:token", requireSupabase, async (req,res)=>{
  const { data, error } = await supabase.from("tickets").select("ticket_code,status,customer_name,event_id,events(name,event_date,venue,location),ticket_types(name)").eq("qr_token",req.params.token).maybeSingle();
  if(error || !data) return res.status(404).send("Ticket not found.");
  const event = data.events;
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ticket Verification</title><style>body{font-family:Arial;max-width:520px;margin:40px auto;padding:20px} .box{padding:24px;border:1px solid #ddd;border-radius:18px}.ok{font-size:28px;font-weight:700}</style></head><body><div class="box"><div class="ok">${data.status==="valid"?"✓ VALID TICKET":"⚠ TICKET "+data.status.toUpperCase()}</div><p><b>${data.customer_name}</b></p><p>${event?.name||""}</p><p>${data.ticket_types?.name||""}</p><p>Ticket: ${data.ticket_code}</p><p>${event?.venue||""}</p>${data.status==="valid"?`<form method="post" action="/api/checkin/${data.qr_token}"><button style="padding:14px 20px">CHECK IN</button></form>`:""}</div></body></html>`);
});

app.post("/api/checkin/:token", requireSupabase, async (req,res)=>{
  const { data: ticket } = await supabase.from("tickets").select("id,status").eq("qr_token",req.params.token).maybeSingle();
  if(!ticket) return res.status(404).send("Ticket not found");
  if(ticket.status !== "valid") return res.status(409).send("Ticket already used or invalid.");
  const { error } = await supabase.from("tickets").update({status:"used",checked_in_at:new Date().toISOString()}).eq("id",ticket.id).eq("status","valid");
  if(error) return res.status(500).send(error.message);
  res.send("<h2>✓ CHECK-IN SUCCESSFUL</h2>");
});

app.use(express.static(path.join(__dirname, "public")));

// Express 5 wildcard route — serves the frontend for non-API routes.
app.get("/{*splat}", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// Run normally when started with `npm start`.
// On Vercel, the exported Express app is used as the serverless function.
if (require.main === module) {
  app.listen(PORT, () => console.log(`DJ Garvin site running on ${BASE}`));
}

module.exports = app;
