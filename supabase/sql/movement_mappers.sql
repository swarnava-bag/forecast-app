-- Forecast vs Movement — editable movement-specific mappers.
-- (Combo/SKU mapping stays in Mapper Studio: sku_master + combo_mapper_rows.)
-- Apply once, then run movement_mappers_seed.sql to load the current values.

create table if not exists public.movement_customer_map (
  customer   text primary key,          -- SO Party Name
  channel    text,                       -- MT / GT / Qcom / B2B / B2C / Growth / CSD …
  platform   text,                       -- Qcom platform: Blinkit / Zepto / Instamart / Flipkart Minutes
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

create table if not exists public.movement_warehouse_map (
  warehouse  text primary key,          -- STN To Warehouse (CFA / 3PL)
  channel    text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

-- FG-code transitions: an old or variant FG code that should resolve to a given
-- New Master SKU (e.g. 14473G ↔ 21107N). Wins over sku_master resolution.
create table if not exists public.movement_fg_alias (
  fg_code        text primary key,       -- the raw FG code as it appears in the file
  new_master_sku text not null,
  note           text,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users (id)
);

do $$
declare t text;
begin
  foreach t in array array['movement_customer_map','movement_warehouse_map','movement_fg_alias'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select to authenticated using (true)', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_write on public.%I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;
