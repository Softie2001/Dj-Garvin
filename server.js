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

app.get("/api/tickets/verify", requireSupabase, async (req,res)=>{
  const token=String(req.query.token||'').trim();
  if(!token) return res.status(400).json({valid:false,message:"Missing ticket QR token."});
  const {data,error}=await supabase.from("tickets").select("ticket_code,qr_token,status,customer_name,event_id,events(name,event_date,venue,location),ticket_types(name)").eq("qr_token",token).maybeSingle();
  if(error) return res.status(500).json({valid:false,message:error.message});
  if(!data) return res.status(404).json({valid:false,message:"Ticket not found."});
  return res.json({
    valid:data.status==="valid",
    ticket_ref:data.ticket_code,
    customer_name:data.customer_name,
    event_name:data.events?.name||'',
    ticket_type:data.ticket_types?.name||'',
    status:data.status,
    message:data.status==="valid"?"Valid ticket.":`Ticket is ${String(data.status||'invalid').replace('_',' ')}.`
  });
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

app.use(express.static(path.join(__dirname,"public")));
app.get("*", (req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT, ()=>console.log(`DJ Garvin site running on ${BASE}`));
