-- AOP Sales — monthly actuals by SKU × channel, both as exploded Singles and at
-- the Combo level. Fed from the "AOP Singles Reconciled" workbook; appended each
-- month (unique key upserts, so re-uploading a month replaces it).
--   nto / gto are in ₹ Crore.  qty is units.
create table if not exists public.aop_sales (
  id             uuid primary key default gen_random_uuid(),
  forecast_month date not null,                 -- first of month
  channel        text not null,
  master_sku     text not null,                 -- AOP master SKU (G-stripped)
  kind           text not null check (kind in ('single','combo')),
  category       text,
  qty            numeric not null default 0,
  nto            numeric not null default 0,     -- ₹ Cr
  gto            numeric not null default 0,     -- ₹ Cr
  uploaded_at    timestamptz not null default now(),
  uploaded_by    uuid references auth.users (id),
  unique (forecast_month, channel, master_sku, kind)
);

alter table public.aop_sales enable row level security;

drop policy if exists aop_sales_read on public.aop_sales;
create policy aop_sales_read on public.aop_sales
  for select to authenticated using (true);

drop policy if exists aop_sales_write on public.aop_sales;
create policy aop_sales_write on public.aop_sales
  for all to authenticated using (true) with check (true);

create index if not exists aop_sales_month_idx    on public.aop_sales (forecast_month);
create index if not exists aop_sales_channel_idx  on public.aop_sales (channel);
create index if not exists aop_sales_kind_idx      on public.aop_sales (kind);
create index if not exists aop_sales_category_idx on public.aop_sales (category);
