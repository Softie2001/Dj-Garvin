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
const PAYPAL_MODE = String(process.env.PAYPAL_MODE || "sandbox").toLowerCase();
const PAYPAL_BASE = PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function requireSupabase(req, res, next) {
  if (!supabase) return res.status(500).json({ error: "Supabase is not configured." });
  next();
}
function orderNumber() { return "DG-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase(); }
function ticketCode() { return "TKT-" + crypto.randomBytes(5).toString("hex").toUpperCase(); }
function clean(v, max=200) { return String(v ?? "").trim().slice(0,max); }
function positiveInt(v) { const n=Number(v); return Number.isInteger(n)&&n>0?n:0; }
function paypalConfigured(){ return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET); }

function emailConfigured(){ return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS); }
function transporter(){
  if(!emailConfigured()) return null;
  return nodemailer.createTransport({
    host:process.env.SMTP_HOST,
    port:Number(process.env.SMTP_PORT||587),
    secure:String(process.env.SMTP_SECURE).toLowerCase()==="true",
    auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}
  });
}
function escapeHtml(v){ return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[m])); }
async function getOrderTickets(orderId){
  const {data,error}=await supabase.from("tickets").select("id,ticket_code,qr_token,customer_name,status,event_id,ticket_type_id,ticket_types(name),events(name,event_date,venue,location)").eq("order_id",orderId).order("created_at");
  if(error) throw new Error(error.message); return data||[];
}
async function sendTicketEmail(order,tickets){
  const mailer=transporter();
  if(!mailer) return {sent:false,reason:"smtp_not_configured"};
  if(!order?.customer_email||!tickets?.length) return {sent:false,reason:"missing_email_or_tickets"};

  const attachments=[];
  const passes=[];

  for(let i=0;i<tickets.length;i++){
    const ticket=tickets[i];
    const event=ticket.events||{};
    const ticketType=ticket.ticket_types?.name||"Event Ticket";
    const verifyUrl=`${BASE}/ticket/verify/${encodeURIComponent(ticket.qr_token)}`;
    const cid=`djgarvin-qr-${ticket.id||i}@djgarvin`;

    let qrDataUrl=null;
    try{
      qrDataUrl=await QRCode.toDataURL(verifyUrl,{
        width:420,
        margin:2,
        errorCorrectionLevel:"M"
      });
    }catch(err){
      console.error("QR generation failed:",err);
    }

    if(qrDataUrl){
      attachments.push({
        filename:`DJ-Garvin-${ticket.ticket_code}.png`,
        content:Buffer.from(qrDataUrl.replace(/^data:image\/png;base64,/,""),"base64"),
        contentType:"image/png",
        cid
      });
    }

    const eventDate=event.event_date
      ? new Intl.DateTimeFormat("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric",timeZone:"Europe/London"}).format(new Date(event.event_date))
      : "—";

    const eventTime=event.event_date
      ? new Intl.DateTimeFormat("en-GB",{hour:"numeric",minute:"2-digit",hour12:true,timeZone:"Europe/London"}).format(new Date(event.event_date))
      : "—";

    passes.push(`
      <div style="width:100%;max-width:390px;margin:0 auto 24px;background:#fff;border:1px solid #dedede;border-radius:20px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.08);">
        <div style="background:#0b0b0b;color:#fff;padding:24px 20px;text-align:center;">
          <div style="color:#e7b96d;font-size:11px;letter-spacing:2.5px;font-weight:800;">DJ GARVIN</div>
          <div style="font-size:12px;color:#c9c9c9;margin-top:8px;">DIGITAL EVENT PASS</div>
          ${qrDataUrl?`<div style="margin:20px auto 10px;background:#fff;border-radius:14px;padding:12px;width:220px;"><img src="cid:${cid}" alt="Scan this QR code at entry" width="196" style="display:block;width:196px;height:196px;margin:auto;"></div>`:""}
          <div style="font-size:12px;color:#ddd;margin-top:8px;">Scan this QR code at entry</div>
        </div>

        <div style="height:20px;position:relative;background:#fff;">
          <div style="border-top:2px dashed #cfcfcf;position:absolute;left:18px;right:18px;top:9px;"></div>
          <span style="position:absolute;left:-10px;top:-2px;width:20px;height:20px;border-radius:50%;background:#f5f5f5;"></span>
          <span style="position:absolute;right:-10px;top:-2px;width:20px;height:20px;border-radius:50%;background:#f5f5f5;"></span>
        </div>

        <div style="padding:4px 20px 24px;">
          <div style="font-size:20px;line-height:1.25;font-weight:800;color:#111;margin:0 0 18px;">${escapeHtml(event.name||"DJ Garvin Event")}</div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;">
            <div>
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#888;">Attendee Name</div>
              <div style="font-size:14px;font-weight:700;color:#111;margin-top:3px;">${escapeHtml(ticket.customer_name||`${order.customer_first_name||""} ${order.customer_last_name||""}`.trim())}</div>
            </div>
            <div>
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#888;">Event Date</div>
              <div style="font-size:14px;font-weight:700;color:#111;margin-top:3px;">${escapeHtml(eventDate)}</div>
            </div>
            <div>
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#888;">Venue / Location</div>
              <div style="font-size:14px;font-weight:700;color:#111;margin-top:3px;">${escapeHtml([event.venue,event.location].filter(Boolean).join(", ")||"—")}</div>
            </div>
            <div>
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#888;">Event Time</div>
              <div style="font-size:14px;font-weight:700;color:#111;margin-top:3px;">${escapeHtml(eventTime)}</div>
            </div>
          </div>

          <div style="margin-top:18px;padding-top:14px;border-top:1px solid #ececec;font-size:12px;color:#666;">
            <strong style="color:#111;">Ticket:</strong> ${escapeHtml(ticket.ticket_code)}
            &nbsp; • &nbsp;
            <strong style="color:#111;">Type:</strong> ${escapeHtml(ticketType)}
          </div>
        </div>
      </div>
    `);
  }

  const subject=`DJ Garvin — Your ticket${tickets.length>1?"s":""} (${order.order_number})`;

  const html=`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#171717;">
  <div style="width:100%;padding:24px 12px;">
    <div style="max-width:620px;margin:0 auto;">
      <div style="text-align:center;padding:8px 12px 22px;">
        <div style="font-size:12px;letter-spacing:3px;font-weight:800;color:#111;">DJ GARVIN</div>
        <h1 style="font-size:24px;line-height:1.2;margin:10px 0 6px;color:#111;">Your Ticket Confirmation</h1>
        <p style="margin:0;color:#777;font-size:14px;">Your digital event pass is ready.</p>
      </div>

      <p style="font-size:15px;line-height:1.6;margin:0 auto 18px;max-width:390px;">
        Hello ${escapeHtml(order.customer_first_name||"")},<br>
        Your payment has been received. Keep this email and present your QR code at the event entrance.
      </p>

      ${passes.join("")}

      <div style="max-width:390px;margin:0 auto;text-align:center;color:#777;font-size:12px;line-height:1.6;">
        Order: ${escapeHtml(order.order_number)}<br>
        Total paid: £${Number(order.total_gbp||0).toFixed(2)}
      </div>
    </div>
  </div>
</body>
</html>`;

  const text=[
    "DJ GARVIN — TICKET CONFIRMATION",
    "",
    `Hello ${order.customer_first_name||""},`,
    "Your payment has been received. Your digital event pass is ready.",
    "",
    ...tickets.map(t=>`${t.ticket_types?.name||"Event Ticket"} — ${t.ticket_code}`),
    "",
    `Order: ${order.order_number}`,
    `Total paid: £${Number(order.total_gbp||0).toFixed(2)}`,
    "",
    "Present the QR code from this email at the event entrance."
  ].join("\n");

  await mailer.sendMail({
    from:process.env.SMTP_FROM||process.env.SMTP_USER,
    to:order.customer_email,
    subject,
    text,
    html,
    attachments
  });

  return {sent:true};
}

async function isTicketEmailSent(orderId){
  const {data:payment}=await supabase.from("payments").select("raw_event").eq("order_id",orderId).maybeSingle();
  return Boolean(payment?.raw_event?.ticket_email_sent_at);
}

async function markTicketEmailSent(orderId){
  const {data:payment}=await supabase.from("payments").select("id,raw_event").eq("order_id",orderId).maybeSingle();
  if(!payment) return;
  const rawEvent=(payment.raw_event&&typeof payment.raw_event==="object")?payment.raw_event:{};
  rawEvent.ticket_email_sent_at=new Date().toISOString();
  await supabase.from("payments").update({raw_event:rawEvent}).eq("id",payment.id);
}

async function emailPaidOrder(order,tickets){
  if(!tickets?.length) return {sent:false,reason:"no_tickets"};
  if(await isTicketEmailSent(order.id)) return {sent:false,skipped:true,reason:"already_sent"};
  try{
    const result=await sendTicketEmail(order,tickets);
    if(result.sent) await markTicketEmailSent(order.id);
    return result;
  }catch(err){
    console.error("ticket email failed:",err);
    return {sent:false,reason:err.message||"ticket_email_failed"};
  }
}

async function paypalToken(){
  if(!paypalConfigured()) throw new Error("PayPal is not configured on the server.");
  const basic=Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r=await fetch(`${PAYPAL_BASE}/v1/oauth2/token`,{
    method:"POST",
    headers:{Authorization:`Basic ${basic}`,"Content-Type":"application/x-www-form-urlencoded"},
    body:"grant_type=client_credentials"
  });
  const text=await r.text(); let data={}; try{data=text?JSON.parse(text):{}}catch{}
  if(!r.ok) throw new Error(data.error_description||data.message||"PayPal authentication failed.");
  return data.access_token;
}
async function paypalRequest(url, options={}){
  const token=await paypalToken();
  const r=await fetch(`${PAYPAL_BASE}${url}`,{
    ...options,
    headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`,...(options.headers||{})}
  });
  const text=await r.text(); let data={}; try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!r.ok){ const msg=data?.details?.map(x=>x.description).filter(Boolean).join("; ")||data?.message||data?.raw||`PayPal request failed (${r.status})`; const e=new Error(msg); e.status=r.status; throw e; }
  return data;
}

app.get("/api/health",(req,res)=>res.json({ok:true,supabase:!!supabase,paypal:paypalConfigured(),paypalMode:PAYPAL_MODE,email:emailConfigured()}));

app.get("/api/events",requireSupabase,async(req,res)=>{
  const {data,error}=await supabase.from("events").select("*, ticket_types(*)").eq("status","published").eq("sales_open",true).order("event_date",{ascending:true});
  if(error)return res.status(500).json({error:error.message}); res.json(data||[]);
});

// Supports both /api/events/:id and /api/events/:slug because the ticket page uses the event id.
app.get("/api/events/:key",requireSupabase,async(req,res)=>{
  const key=req.params.key;
  let q=supabase.from("events").select("*, ticket_types(*)").eq("status","published").eq("sales_open",true);
  let result=await q.eq("id",key).maybeSingle();
  if(result.error && /uuid|invalid input syntax/i.test(result.error.message)) result={data:null,error:null};
  if(!result.data){ result=await supabase.from("events").select("*, ticket_types(*)").eq("status","published").eq("sales_open",true).eq("slug",key).maybeSingle(); }
  if(result.error)return res.status(500).json({error:result.error.message});
  if(!result.data)return res.status(404).json({error:"Event not found"});
  res.json(result.data);
});

app.post("/api/bookings",requireSupabase,async(req,res)=>{
  const {data,error}=await supabase.from("bookings").insert([req.body]).select().single();
  if(error)return res.status(400).json({error:error.message}); res.json({ok:true,booking:data});
});

async function getCart(eventId, requestedItems){
  if(!eventId||!Array.isArray(requestedItems)||!requestedItems.length) throw new Error("Select at least one ticket.");
  const ids=[...new Set(requestedItems.map(x=>clean(x?.ticket_type_id||x?.id,100)).filter(Boolean))];
  const {data:event,error:eventError}=await supabase.from("events").select("*").eq("id",eventId).maybeSingle();
  if(eventError)throw new Error(eventError.message);
  if(!event)throw new Error("Event not found.");
  if(event.status!=="published"||event.sales_open!==true)throw new Error("Ticket sales are currently closed.");
  const {data:tickets,error}=await supabase.from("ticket_types").select("id,event_id,name,price_gbp,price_pence,currency,capacity,quantity_sold,status,sales_start,sales_end,description,whats_included,is_group_ticket").eq("event_id",eventId).in("id",ids);
  if(error)throw new Error(error.message);
  const map=new Map((tickets||[]).map(t=>[String(t.id),t])); const now=Date.now(); const items=[];
  for(const req of requestedItems){
    const id=clean(req?.ticket_type_id||req?.id,100), qty=positiveInt(req?.quantity); if(!id||!qty)continue;
    const t=map.get(id); if(!t)throw new Error("One of the selected tickets is unavailable.");
    if(!["on_sale"].includes(t.status))throw new Error(`${t.name} is not currently on sale.`);
    if(t.sales_start && new Date(t.sales_start).getTime()>now)throw new Error(`${t.name} sales have not started yet.`);
    if(t.sales_end && new Date(t.sales_end).getTime()<now)throw new Error(`${t.name} sales have ended.`);
    const cap=Number(t.capacity||0), sold=Number(t.quantity_sold||0); if(cap>0&&sold+qty>cap)throw new Error(`Not enough ${t.name} tickets remain.`);
    const p=Number.isFinite(Number(t.price_pence))&&Number(t.price_pence)>=0?Number(t.price_pence):Math.round(Number(t.price_gbp||0)*100);
    if(!Number.isInteger(p)||p<0)throw new Error(`Invalid price configured for ${t.name}.`);
    items.push({ticket_type_id:t.id,name:t.name,quantity:qty,unit_price_pence:p,total_pence:p*qty,is_group_ticket:Boolean(t.is_group_ticket)});
  }
  if(!items.length)throw new Error("Select at least one ticket.");
  const totalPence=items.reduce((a,x)=>a+x.total_pence,0); if(totalPence<=0)throw new Error("The selected tickets have no payable total.");
  return {event,items,totalPence};
}

app.post("/api/paypal/create-order",requireSupabase,async(req,res)=>{
  try{
    const eventId=clean(req.body.event_id,100); const first=clean(req.body.first_name,80); const last=clean(req.body.last_name,80); const email=clean(req.body.email,254); const phone=clean(req.body.phone,50);
    if(!first||!last||!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:"Enter your first name, last name and a valid email."});
    const cart=await getCart(eventId,req.body.items); const total=(cart.totalPence/100).toFixed(2); const paypalOrder=await paypalRequest("/v2/checkout/orders",{
      method:"POST",headers:{"PayPal-Request-Id":crypto.randomUUID(),Prefer:"return=representation"},body:JSON.stringify({
        intent:"CAPTURE",purchase_units:[{reference_id:String(cart.event.id),description:cart.event.name.slice(0,127),custom_id:eventId,amount:{currency_code:"GBP",value:total,breakdown:{item_total:{currency_code:"GBP",value:total}}},items:cart.items.map(i=>({name:i.name.slice(0,127),quantity:String(i.quantity),unit_amount:{currency_code:"GBP",value:(i.unit_price_pence/100).toFixed(2)},category:"DIGITAL_GOODS"}))}],
        application_context:{brand_name:"DJ Garvin",user_action:"PAY_NOW",shipping_preference:"NO_SHIPPING",return_url:`${BASE}/payment-success.html`,cancel_url:`${BASE}/payment-cancelled.html`}
      })
    });
    const {data:order,error:orderError}=await supabase.from("orders").insert([{
      order_number:orderNumber(),event_id:cart.event.id,customer_first_name:first,customer_last_name:last,customer_email:email,customer_phone:phone||null,currency:"GBP",total_gbp:total,status:"pending",paypal_order_id:paypalOrder.id
    }]).select().single();
    if(orderError)throw new Error(orderError.message);
    const {error:itemError}=await supabase.from("order_items").insert(cart.items.map(i=>({order_id:order.id,ticket_type_id:i.ticket_type_id,quantity:i.quantity,unit_price_gbp:(i.unit_price_pence/100).toFixed(2)})));
    if(itemError){await supabase.from("orders").delete().eq("id",order.id);throw new Error(itemError.message);}
    const approval=paypalOrder.links?.find(x=>x.rel==="approve")?.href||paypalOrder.links?.find(x=>x.rel==="payer-action")?.href||null;
    res.json({ok:true,id:paypalOrder.id,approval_url:approval,order_id:order.id,order_number:order.order_number,total_gbp:total,currency:"GBP"});
  }catch(e){console.error(e);res.status(e.status&&e.status<500?e.status:500).json({error:e.message||"Could not create PayPal order."});}
});

async function finalizePaidOrder(dbOrder,captured){
  const capture=captured.purchase_units?.[0]?.payments?.captures?.[0]; if(!capture?.id)throw new Error("PayPal returned no capture details.");
  const paidAmount=Number(capture.amount?.value); if(capture.amount?.currency_code!=="GBP"||Math.abs(paidAmount-Number(dbOrder.total_gbp))>0.01)throw new Error("PayPal payment amount does not match the booking total.");
  const {data:updated,error:updateError}=await supabase.from("orders").update({status:"paid",paypal_capture_id:capture.id,paid_at:new Date().toISOString()}).eq("id",dbOrder.id).in("status",["pending"]).select().maybeSingle();
  if(updateError)throw new Error(updateError.message);
  if(!updated){ const {data:already}=await supabase.from("orders").select("*").eq("id",dbOrder.id).maybeSingle(); return {order:already,newlyPaid:false,tickets:await getOrderTickets(dbOrder.id)}; }
  const {data:existingPayment}=await supabase.from("payments").select("id").eq("order_id",dbOrder.id).maybeSingle();
  if(!existingPayment){ const {error}=await supabase.from("payments").insert([{order_id:dbOrder.id,provider:"paypal",provider_order_id:dbOrder.paypal_order_id,provider_capture_id:capture.id,amount_gbp:paidAmount.toFixed(2),status:"completed",raw_event:captured}]); if(error)throw new Error(error.message); }
  const {data:items,error:itemError}=await supabase.from("order_items").select("*").eq("order_id",dbOrder.id); if(itemError)throw new Error(itemError.message);
  const ticketRows=[];
  for(const item of items||[]){
    const {data:t,error}=await supabase.from("ticket_types").select("id,name,event_id,capacity,quantity_sold,status").eq("id",item.ticket_type_id).maybeSingle(); if(error||!t)throw new Error(error?.message||"Ticket type not found.");
    const {count}=await supabase.from("tickets").select("id",{count:"exact",head:true}).eq("order_item_id",item.id); const alreadyCount=Number(count||0); const needed=Math.max(0,Number(item.quantity)-alreadyCount);
    if(needed>0){
      if(Number(t.capacity)>0&&Number(t.quantity_sold||0)+needed>Number(t.capacity))throw new Error(`Not enough ${t.name} tickets remain.`);
      for(let i=0;i<needed;i++)ticketRows.push({order_id:dbOrder.id,order_item_id:item.id,ticket_type_id:t.id,event_id:dbOrder.event_id,ticket_code:ticketCode(),qr_token:crypto.randomBytes(24).toString("hex"),customer_name:`${dbOrder.customer_first_name} ${dbOrder.customer_last_name}`.trim(),status:"valid"});
      const newSold=Number(t.quantity_sold||0)+needed; const newStatus=Number(t.capacity)>0&&newSold>=Number(t.capacity)?"sold_out":t.status; const {error:upErr}=await supabase.from("ticket_types").update({quantity_sold:newSold,status:newStatus}).eq("id",t.id); if(upErr)throw new Error(upErr.message);
    }
  }
  if(ticketRows.length){ const {error}=await supabase.from("tickets").insert(ticketRows); if(error)throw new Error(error.message); }
  const tickets=await getOrderTickets(dbOrder.id);
  return {order:updated,newlyPaid:true,tickets};
}

app.post("/api/paypal/capture-order",requireSupabase,async(req,res)=>{
  try{
    let tickets=[];
    const paypalId=clean(req.body.order_id,100); if(!paypalId)return res.status(400).json({error:"PayPal order ID is required."});
    const {data:dbOrder,error}=await supabase.from("orders").select("*").eq("paypal_order_id",paypalId).maybeSingle(); if(error)throw new Error(error.message); if(!dbOrder)return res.status(404).json({error:"Booking order not found."});
    if(dbOrder.status!=="paid"){
      const captured=await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(paypalId)}/capture`,{method:"POST",headers:{"PayPal-Request-Id":crypto.randomUUID(),Prefer:"return=representation"},body:JSON.stringify({})});
      if(captured.status!=="COMPLETED")return res.status(409).json({error:"PayPal payment was not completed.",status:captured.status});
      const finalized=await finalizePaidOrder(dbOrder,captured);
      tickets=finalized.tickets;
    } else {
      tickets=await getOrderTickets(dbOrder.id);
      const {data:items}=await supabase.from("order_items").select("id,quantity").eq("order_id",dbOrder.id);
      const expectedCount=(items||[]).reduce((s,i)=>s+Number(i.quantity),0);
      if(tickets.length<expectedCount){
        const captured={status:"COMPLETED",purchase_units:[{payments:{captures:[{id:dbOrder.paypal_capture_id,amount:{value:Number(dbOrder.total_gbp).toFixed(2),currency_code:"GBP"}}]}}]};
        const finalized=await finalizePaidOrder(dbOrder,captured);
        tickets=finalized.tickets;
      }
    }
    const paidOrder=(await supabase.from("orders").select("*").eq("id",dbOrder.id).single()).data;
    const emailResult=await emailPaidOrder(paidOrder||dbOrder,tickets||[]);
    const {data:finalOrder}=await supabase.from("orders").select("id,order_number,event_id,customer_first_name,customer_last_name,customer_email,total_gbp,currency,status,paid_at,paypal_capture_id").eq("id",dbOrder.id).single();
    res.json({ok:true,order:finalOrder,tickets:tickets||[],email:{sent:!!emailResult.sent,skipped:!!emailResult.skipped,reason:emailResult.reason||null}});
  }catch(e){console.error("capture",e);res.status(e.status&&e.status<500?e.status:500).json({error:e.message||"Could not capture PayPal order."});}
});

app.get("/api/orders/:orderNumber",requireSupabase,async(req,res)=>{
  const {data:order,error}=await supabase.from("orders").select("id,order_number,event_id,customer_first_name,customer_last_name,customer_email,total_gbp,currency,status,paid_at").eq("order_number",req.params.orderNumber).maybeSingle();
  if(error)return res.status(500).json({error:error.message}); if(!order)return res.status(404).json({error:"Order not found"});
  const {data:tickets}=await supabase.from("tickets").select("ticket_code,qr_token,customer_name,status,event_id,ticket_type_id,ticket_types(name),events(name,event_date,venue,location)").eq("order_id",order.id).order("created_at");
  res.json({order,tickets:tickets||[]});
});

/* QR verification API used by checkin.html. */
app.get("/api/tickets/verify",requireSupabase,async(req,res)=>{
  try{
    const token=clean(req.query.token||req.query.qr_token,500);
    if(!token)return res.status(400).json({valid:false,message:"No ticket QR token was provided."});
    const {data,error}=await supabase.from("tickets").select("id,ticket_code,qr_token,status,customer_name,event_id,ticket_type_id,ticket_types(name),events(name,event_date,venue,location)").eq("qr_token",token).maybeSingle();
    if(error){console.error("Ticket verification error:",error);return res.status(500).json({valid:false,message:"Ticket verification service is unavailable."});}
    if(!data)return res.status(404).json({valid:false,message:"Ticket not found."});
    if(data.status!=="valid")return res.status(409).json({valid:false,message:data.status==="used"?"This ticket has already been used.":`This ticket is ${data.status}.`,ticket_ref:data.ticket_code,status:data.status});
    res.json({valid:true,ticket_ref:data.ticket_code,ticket_code:data.ticket_code,customer_name:data.customer_name,event_name:data.events?.name||"",event_date:data.events?.event_date||null,venue:data.events?.venue||"",location:data.events?.location||"",ticket_type:data.ticket_types?.name||"",status:data.status});
  }catch(e){console.error("verify ticket",e);res.status(500).json({valid:false,message:"Ticket verification service is unavailable."});}
});

app.get("/ticket/verify/:token",requireSupabase,async(req,res)=>{
  const {data,error}=await supabase.from("tickets").select("ticket_code,status,customer_name,event_id,events(name,event_date,venue,location),ticket_types(name)").eq("qr_token",req.params.token).maybeSingle();
  if(error||!data)return res.status(404).send("Ticket not found."); const event=data.events;
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ticket Verification</title></head><body><div style="font-family:Arial;max-width:520px;margin:40px auto;padding:20px"><h2>${data.status==="valid"?"✓ VALID TICKET":"⚠ TICKET "+data.status.toUpperCase()}</h2><p><b>${data.customer_name}</b></p><p>${event?.name||""}</p><p>${data.ticket_types?.name||""}</p><p>Ticket: ${data.ticket_code}</p>${data.status==="valid"?`<form method="post" action="/api/checkin/${data.qr_token}"><button style="padding:14px 20px">CHECK IN</button></form>`:""}</div></body></html>`);
});
app.post("/api/checkin/:token",requireSupabase,async(req,res)=>{
  try{
    const token=clean(req.params.token,500);
    const {data:t,error:findError}=await supabase.from("tickets").select("id,status").eq("qr_token",token).maybeSingle();
    if(findError)return res.status(500).send(findError.message);
    if(!t)return res.status(404).json({ok:false,message:"Ticket not found."});
    if(t.status!=="valid")return res.status(409).json({ok:false,message:t.status==="used"?"Ticket has already been used.":"Ticket is already invalid."});
    const {data:updated,error}=await supabase.from("tickets").update({status:"used",checked_in_at:new Date().toISOString()}).eq("id",t.id).eq("status","valid").select("id,status,checked_in_at").maybeSingle();
    if(error)return res.status(500).json({ok:false,message:error.message});
    if(!updated)return res.status(409).json({ok:false,message:"Ticket was already used or invalid."});
    res.json({ok:true,message:"Check-in successful.",ticket:updated});
  }catch(e){console.error("checkin",e);res.status(500).send("Check-in service unavailable.");}
});

app.post("/api/paypal/webhook",requireSupabase,async(req,res)=>{const event=req.body||{};if(!event.id)return res.status(400).send("Missing event id");const {data:existing}=await supabase.from("webhook_events").select("id").eq("provider_event_id",event.id).maybeSingle();if(existing)return res.json({ok:true,duplicate:true});await supabase.from("webhook_events").insert([{provider:"paypal",provider_event_id:event.id,event_type:event.event_type,payload:event}]);res.json({ok:true});});

app.use(express.static(path.join(__dirname,"public")));
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
if(require.main===module)app.listen(PORT,()=>console.log(`DJ Garvin site running on ${BASE}`));
module.exports=app;
