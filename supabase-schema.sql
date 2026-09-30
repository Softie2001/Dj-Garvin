create extension if not exists pgcrypto;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  image_url text,
  description text,
  event_date timestamptz not null,
  venue text,
  location text,
  sales_open boolean not null default true,
  status text not null default 'draft' check (status in ('draft','published','closed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  image_url text,
  description text,
  includes text,
  price_gbp numeric(12,2) not null check (price_gbp >= 0),
  capacity integer not null check (capacity >= 0),
  sold_count integer not null default 0 check (sold_count >= 0),
  sales_start timestamptz,
  sales_end timestamptz,
  status text not null default 'active' check (status in ('active','sold_out','hidden')),
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text unique not null,
  event_id uuid not null references public.events(id),
  customer_first_name text not null,
  customer_last_name text not null,
  customer_email text not null,
  customer_phone text,
  currency text not null default 'GBP',
  total_gbp numeric(12,2) not null check (total_gbp >= 0),
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled','refunded')),
  paypal_order_id text unique,
  paypal_capture_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  ticket_type_id uuid not null references public.ticket_types(id),
  quantity integer not null check (quantity > 0),
  unit_price_gbp numeric(12,2) not null check (unit_price_gbp >= 0)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  provider text not null default 'paypal',
  provider_order_id text,
  provider_capture_id text,
  amount_gbp numeric(12,2) not null,
  status text not null,
  raw_event jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  ticket_type_id uuid not null references public.ticket_types(id),
  event_id uuid not null references public.events(id),
  ticket_code text unique not null,
  qr_token text unique not null,
  customer_name text not null,
  status text not null default 'valid' check (status in ('valid','used','cancelled','refunded')),
  checked_in_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'paypal',
  provider_event_id text unique not null,
  event_type text,
  payload jsonb,
  processed_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text,
  phone text,
  event_type text,
  event_date date,
  event_location text,
  guests integer,
  message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ticket_types_event on public.ticket_types(event_id);
create index if not exists idx_orders_event on public.orders(event_id);
create index if not exists idx_tickets_event on public.tickets(event_id);
create index if not exists idx_tickets_qr on public.tickets(qr_token);

alter table public.events enable row level security;
alter table public.ticket_types enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.tickets enable row level security;
alter table public.webhook_events enable row level security;
alter table public.bookings enable row level security;

drop policy if exists "Public can view published events" on public.events;
create policy "Public can view published events" on public.events
for select using (status = 'published');

drop policy if exists "Public can view active ticket types" on public.ticket_types;
create policy "Public can view active ticket types" on public.ticket_types
for select using (
  status = 'active'
  and exists (
    select 1 from public.events e
    where e.id = event_id and e.status = 'published' and e.sales_open = true
  )
);

drop policy if exists "Public can submit booking" on public.bookings;
create policy "Public can submit booking" on public.bookings
for insert with check (true);
