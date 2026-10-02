require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");

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

app.get("/api/health",(req,res)=>res.json({ok:true,supabase:!!supabase,paypal:paypalConfigured(),paypalMode:PAYPAL_MODE}));

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
        application_context:{brand_name:"DJ Garvin",user_action:"PAY_NOW",shipping_preference:"NO_SHIPPING",return_url:`${BASE}/payment-success`,cancel_url:`${BASE}/payment-cancelled`}
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
  if(!updated){
    const {data:already}=await supabase.from("orders").select("*").eq("id",dbOrder.id).maybeSingle();
    return already;
  }
  const {data:existingPayment}=await supabase.from("payments").select("id").eq("order_id",dbOrder.id).maybeSingle();
  if(!existingPayment){const {error}=await supabase.from("payments").insert([{order_id:dbOrder.id,provider:"paypal",provider_order_id:dbOrder.paypal_order_id,provider_capture_id:capture.id,amount_gbp:paidAmount.toFixed(2),status:"completed",raw_event:captured}]);if(error)throw new Error(error.message);}
  const {data:items,error:itemError}=await supabase.from("order_items").select("*").eq("order_id",dbOrder.id); if(itemError)throw new Error(itemError.message);
  const ticketRows=[];
  for(const item of items||[]){
    const {data:t,error}=await supabase.from("ticket_types").select("id,name,event_id,capacity,quantity_sold,status").eq("id",item.ticket_type_id).maybeSingle(); if(error||!t)throw new Error(error?.message||"Ticket type not found.");
    const {count}=await supabase.from("tickets").select("id",{count:"exact",head:true}).eq("order_item_id",item.id); const alreadyCount=Number(count||0); const needed=Math.max(0,Number(item.quantity)-alreadyCount);
    if(needed>0){if(Number(t.capacity)>0 && Number(t.quantity_sold||0)+needed>Number(t.capacity))throw new Error(`Not enough ${t.name} tickets remain.`); for(let i=0;i<needed;i++)ticketRows.push({order_id:dbOrder.id,order_item_id:item.id,ticket_type_id:t.id,event_id:dbOrder.event_id,ticket_code:ticketCode(),qr_token:crypto.randomBytes(24).toString("hex"),customer_name:`${dbOrder.customer_first_name} ${dbOrder.customer_last_name}`.trim(),status:"valid"});
      const newSold=Number(t.quantity_sold||0)+needed; const newStatus=Number(t.capacity)>0&&newSold>=Number(t.capacity)?"sold_out":t.status; const {error:upErr}=await supabase.from("ticket_types").update({quantity_sold:newSold,status:newStatus}).eq("id",t.id); if(upErr)throw new Error(upErr.message);
    }
  }
  if(ticketRows.length){const {error}=await supabase.from("tickets").insert(ticketRows);if(error)throw new Error(error.message);}
  return updated;
}

app.post("/api/paypal/capture-order",requireSupabase,async(req,res)=>{
  try{
    const paypalId=clean(req.body.order_id,100); if(!paypalId)return res.status(400).json({error:"PayPal order ID is required."});
    const {data:dbOrder,error}=await supabase.from("orders").select("*").eq("paypal_order_id",paypalId).maybeSingle(); if(error)throw new Error(error.message); if(!dbOrder)return res.status(404).json({error:"Booking order not found."});
    if(dbOrder.status!=="paid"){
      const captured=await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(paypalId)}/capture`,{method:"POST",headers:{"PayPal-Request-Id":crypto.randomUUID(),Prefer:"return=representation"},body:JSON.stringify({})});
      if(captured.status!=="COMPLETED")return res.status(409).json({error:"PayPal payment was not completed.",status:captured.status});
      await finalizePaidOrder(dbOrder,captured);
    } else {
      // If the buyer refreshed the success page after payment, make sure tickets exist.
      const {data:items}=await supabase.from("order_items").select("id,quantity").eq("order_id",dbOrder.id);
      const {count}=await supabase.from("tickets").select("id",{count:"exact",head:true}).eq("order_id",dbOrder.id);
      if(Number(count||0)<(items||[]).reduce((s,i)=>s+Number(i.quantity),0)){
        const captured={status:"COMPLETED",purchase_units:[{payments:{captures:[{id:dbOrder.paypal_capture_id,amount:{value:Number(dbOrder.total_gbp).toFixed(2),currency_code:"GBP"}}]}}]}; await finalizePaidOrder(dbOrder,captured);
      }
    }
    const {data:finalOrder}=await supabase.from("orders").select("id,order_number,event_id,customer_first_name,customer_last_name,customer_email,total_gbp,currency,status,paid_at,paypal_capture_id").eq("id",dbOrder.id).single();
    const {data:tickets}=await supabase.from("tickets").select("ticket_code,qr_token,customer_name,status,event_id,ticket_type_id,ticket_types(name),events(name,event_date,venue,location)").eq("order_id",dbOrder.id).order("created_at");
    res.json({ok:true,order:finalOrder,tickets:tickets||[]});
  }catch(e){console.error("capture",e);res.status(e.status&&e.status<500?e.status:500).json({error:e.message||"Could not capture PayPal order."});}
});

app.get("/api/orders/:orderNumber",requireSupabase,async(req,res)=>{
  const {data:order,error}=await supabase.from("orders").select("id,order_number,event_id,customer_first_name,customer_last_name,customer_email,total_gbp,currency,status,paid_at").eq("order_number",req.params.orderNumber).maybeSingle();
  if(error)return res.status(500).json({error:error.message}); if(!order)return res.status(404).json({error:"Order not found"});
  const {data:tickets}=await supabase.from("tickets").select("ticket_code,qr_token,customer_name,status,event_id,ticket_type_id,ticket_types(name),events(name,event_date,venue,location)").eq("order_id",order.id).order("created_at");
  res.json({order,tickets:tickets||[]});
});

app.get("/ticket/verify/:token",requireSupabase,async(req,res)=>{
  const {data,error}=await supabase.from("tickets").select("ticket_code,status,customer_name,event_id,events(name,event_date,venue,location),ticket_types(name)").eq("qr_token",req.params.token).maybeSingle();
  if(error||!data)return res.status(404).send("Ticket not found."); const event=data.events;
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ticket Verification</title></head><body><div style="font-family:Arial;max-width:520px;margin:40px auto;padding:20px"><h2>${data.status==="valid"?"✓ VALID TICKET":"⚠ TICKET "+data.status.toUpperCase()}</h2><p><b>${data.customer_name}</b></p><p>${event?.name||""}</p><p>${data.ticket_types?.name||""}</p><p>Ticket: ${data.ticket_code}</p>${data.status==="valid"?`<form method="post" action="/api/checkin/${data.qr_token}"><button style="padding:14px 20px">CHECK IN</button></form>`:""}</div></body></html>`);
});
app.post("/api/checkin/:token",requireSupabase,async(req,res)=>{const {data:t}=await supabase.from("tickets").select("id,status").eq("qr_token",req.params.token).maybeSingle();if(!t)return res.status(404).send("Ticket not found");if(t.status!=="valid")return res.status(409).send("Ticket already used or invalid.");const {error}=await supabase.from("tickets").update({status:"used",checked_in_at:new Date().toISOString()}).eq("id",t.id).eq("status","valid");if(error)return res.status(500).send(error.message);res.send("<h2>✓ CHECK-IN SUCCESSFUL</h2>");});

app.post("/api/paypal/webhook",requireSupabase,async(req,res)=>{const event=req.body||{};if(!event.id)return res.status(400).send("Missing event id");const {data:existing}=await supabase.from("webhook_events").select("id").eq("provider_event_id",event.id).maybeSingle();if(existing)return res.json({ok:true,duplicate:true});await supabase.from("webhook_events").insert([{provider:"paypal",provider_event_id:event.id,event_type:event.event_type,payload:event}]);res.json({ok:true});});

app.use(express.static(path.join(__dirname,"public")));
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
if(require.main===module)app.listen(PORT,()=>console.log(`DJ Garvin site running on ${BASE}`));
module.exports=app;
