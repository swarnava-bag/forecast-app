-- over_under_check — background master data for the Qcom Over/Under Check.
--
-- ─────────────────────────────────────────────────────────────────────────────
--  HOW TO APPLY:  paste this whole file into the Supabase SQL editor and run it.
--  This repo has no migration tooling (see apply_mapper_batch.sql), so this is
--  applied BY HAND. It is idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THE CHECK DOES
--   DRR  = MTD secondary sales / days elapsed ("updated till")
--   DOS  = Forecast / DRR            -- days the forecast will last at current run rate
--   OVER  when DOS > max_shelf_life_days   (forecast outlives the product)
--   UNDER when DOS < channel under_days    (default 20, editable per channel)
--   OK    otherwise
--
-- Shelf life resolves per SKU first, then falls back to the SKU's category. That
-- is why one table carries both scopes rather than two tables: the lookup is a
-- single ordered read, and a category row is a real default, not a placeholder.

-- ── 1. Shelf life master ─────────────────────────────────────────────────────
create table if not exists shelf_life_master (
  id                  uuid primary key default gen_random_uuid(),
  scope               text not null check (scope in ('sku', 'category')),
  scope_key           text not null,          -- new_master_sku when scope='sku', category name when scope='category'
  shelf_life_days     integer check (shelf_life_days is null or shelf_life_days >= 0),
  max_shelf_life_days integer check (max_shelf_life_days is null or max_shelf_life_days >= 0),
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users(id) on delete set null
);

-- Case-insensitive uniqueness: "Bars" and "bars" are the same default.
create unique index if not exists shelf_life_master_scope_key_uniq
  on shelf_life_master (scope, lower(scope_key));

create index if not exists shelf_life_master_scope_idx on shelf_life_master (scope);

-- ── 2. Per-channel thresholds ────────────────────────────────────────────────
-- under_days is the only tunable today; kept in its own table so adding more
-- per-channel knobs later does not require touching shelf life rows.
create table if not exists over_under_channel_settings (
  id           uuid primary key default gen_random_uuid(),
  channel_name text not null,
  under_days   numeric not null default 20 check (under_days >= 0),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);

create unique index if not exists over_under_channel_settings_name_uniq
  on over_under_channel_settings (lower(channel_name));

-- Seed the Qcom channels at the agreed default of 20 days.
insert into over_under_channel_settings (channel_name, under_days)
select v.name, 20
from (values ('Blinkit'), ('Flipkart Minutes'), ('Instamart'), ('Zepto')) as v(name)
where not exists (
  select 1 from over_under_channel_settings s
  where lower(s.channel_name) = lower(v.name)
);

-- ── 3. keep updated_at honest ────────────────────────────────────────────────
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists shelf_life_master_touch on shelf_life_master;
create trigger shelf_life_master_touch before update on shelf_life_master
  for each row execute function touch_updated_at();

drop trigger if exists over_under_channel_settings_touch on over_under_channel_settings;
create trigger over_under_channel_settings_touch before update on over_under_channel_settings
  for each row execute function touch_updated_at();

-- ── 4. RLS: every signed-in user reads; only admins write ────────────────────
alter table shelf_life_master            enable row level security;
alter table over_under_channel_settings  enable row level security;

drop policy if exists shelf_life_read on shelf_life_master;
create policy shelf_life_read on shelf_life_master
  for select to authenticated using (true);

drop policy if exists shelf_life_write on shelf_life_master;
create policy shelf_life_write on shelf_life_master
  for all to authenticated
  using      (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists ou_settings_read on over_under_channel_settings;
create policy ou_settings_read on over_under_channel_settings
  for select to authenticated using (true);

drop policy if exists ou_settings_write on over_under_channel_settings;
create policy ou_settings_write on over_under_channel_settings
  for all to authenticated
  using      (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));
