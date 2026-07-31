-- Forecast vs Movement — multi-month snapshot store.
-- Apply this once (Supabase SQL editor or psql). After it exists, the
-- /api/movement-snapshot route persists uploads here instead of the local
-- filesystem, so the dashboard works on any host (including read-only serverless).

create table if not exists public.movement_snapshots (
  month_key    text primary key,                 -- 'YYYY-MM'
  month_label  text not null,                     -- 'Jun 2026'
  data         jsonb not null,                    -- the full snapshot
  published_at timestamptz not null default now(),
  published_by uuid references auth.users (id)
);

alter table public.movement_snapshots enable row level security;

-- Any authenticated user can read the published snapshots.
drop policy if exists movement_snapshots_read on public.movement_snapshots;
create policy movement_snapshots_read
  on public.movement_snapshots for select
  to authenticated
  using (true);

-- Any authenticated user can publish/refresh a month. Tighten to a role
-- (e.g. supply_chain / admin) here if you want to restrict uploads:
--   using (exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('admin','supply_chain')))
drop policy if exists movement_snapshots_write on public.movement_snapshots;
create policy movement_snapshots_write
  on public.movement_snapshots for all
  to authenticated
  using (true)
  with check (true);
