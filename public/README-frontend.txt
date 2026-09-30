DJ GARVIN FRONTEND UPDATE

This package keeps the original DJ Garvin visual design as the master UI.
Replace only the files inside your existing public/ folder with these files.
Do NOT replace server.js, .env, .env.example, .gitignore, or supabase-schema.sql.

Pages:
- index.html: original homepage design + new Events & Tickets CTA
- about.html: About + What I Play + Events I Play + Videos
- events.html: event/ticket selection
- ticket.html: ticket type quantity +/- and customer details
- admin.html: admin dashboard UI
- checkin.html: QR ticket verification UI

PayPal is intentionally not hard-coded with credentials. The ticket page calls /api/paypal/create-order, which must be connected to the existing backend before live payments.
