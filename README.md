# DJ Garvin — Supabase Ticketing Starter

This is a fresh starter for the DJ Garvin website. It keeps the DJ booking journey separate from the new event ticketing journey.

## Included
- Existing-style DJ homepage
- Separate About page
- What I Play / Events I Play / Videos sections on About
- Book DJ form with WhatsApp + email actions
- Events and ticket-type UI
- Ticket quantity selection
- Customer checkout UI
- Admin dashboard UI
- Staff check-in UI
- QR verification route
- Supabase schema
- Server-side configuration structure
- PayPal integration placeholders ready for credentials

## Supabase setup
1. Create a Supabase project.
2. Open SQL Editor.
3. Run `supabase-schema.sql`.
4. Copy `.env.example` to `.env`.
5. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Run
npm install
npm start

Then open http://localhost:3000

## PayPal
The server contains the integration routes, but real PayPal create/capture and production webhook signature verification should only be enabled after adding the client's Sandbox/Live credentials and configuring the PayPal webhook. Do not put the Client Secret in frontend code.

## Email
Add SMTP settings to `.env` for production email delivery.

## Important
This package is a development starter. Do not treat the placeholder PayPal endpoints as production payment verification until the actual PayPal Orders API and official webhook signature verification are configured.
