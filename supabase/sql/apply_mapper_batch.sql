-- apply_mapper_batch — atomic execution of a mapper write plan.
--
-- ─────────────────────────────────────────────────────────────────────────────
--  HOW TO APPLY:  paste this whole file into the Supabase SQL editor and run it.
--
--  This repo has no migration tooling, so this function is applied BY HAND and
--  nothing proves the database matches this file. That is a real weakness, named
--  openly. Two mitigations:
--    1. /api/admin/mapper/apply is the contract; it falls back to sequential
--       writes if this function is absent, so the app works either way.
--    2. `npm run doctor` reports whether the function exists and whether its
--       source still matches this file.
--  The proper fix is the Supabase CLI + supabase/migrations/. Worth doing.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS EXISTS
-- A launch writes 2N+M rows across two tables. sku_master carries a SKU's
-- attributes; combo_mapper_rows carries its existence and decomposition. A SKU in
-- the first but not the second is invisible to the converter — that is the exact
-- defect this whole effort closed, and it was created by a client that wrote one
-- table and then failed before the other.
--
-- PostgREST gives no cross-statement transaction, so N inserts from a browser can
-- half-apply. Inside a plpgsql function every statement shares one transaction: a
-- failure anywhere rolls back everything. Compensation is not an answer, because
-- the compensation can fail too.
--
-- Single-row edits deliberately do NOT use this. They are idempotent and the Fix
-- button is their compensation. Only the batch needs the guarantee.

-- NOTE ON QUOTING: the body is wrapped in a NAMED dollar quote ($func$), not $$.
-- The Supabase SQL editor's statement splitter mis-handles bare $$ and reports
-- "unterminated dollar-quoted string". A named tag is unambiguous.
--
-- NOTE ON `?`: jsonb key-existence is written as jsonb_exists(x, 'k') rather than
-- the `x ? 'k'` operator, because many Postgres clients read `?` as a bind
-- parameter placeholder and mangle the statement.

create or replace function apply_mapper_batch(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $func$
declare
  w             jsonb;
  set_id        uuid;
  touched_sets  uuid[] := '{}';
  applied       int := 0;
  n             bigint;
begin
  -- payload: { "writes": [ {op, ...}, ... ], "mapperSetIds": ["uuid", ...] }
  -- Op vocabulary mirrors the Write union in lib/mapper/ops.ts exactly. An unknown
  -- op raises rather than being skipped: silently ignoring a write the planner
  -- intended is how data goes half-written.

  for w in select * from jsonb_array_elements(payload -> 'writes')
  loop
    case w ->> 'op'

      when 'insert_sku_master' then
        insert into sku_master (new_master_sku, new_fg_code, product_name, mrp, is_active)
        values (
          w -> 'row' ->> 'new_master_sku',
          nullif(w -> 'row' ->> 'new_fg_code', ''),
          nullif(w -> 'row' ->> 'product_name', ''),
          (w -> 'row' ->> 'mrp')::numeric,
          coalesce((w -> 'row' ->> 'is_active')::boolean, true)
        );

      when 'insert_mapper' then
        insert into combo_mapper_rows (mapper_set_id, master_sku, is_combo, products, fg_code, product_name)
        values (
          (w -> 'row' ->> 'mapper_set_id')::uuid,
          w -> 'row' ->> 'master_sku',
          coalesce((w -> 'row' ->> 'is_combo')::boolean, false),
          coalesce(
            (select array_agg(value::text) from jsonb_array_elements_text(w -> 'row' -> 'products')),
            '{}'::text[]
          ),
          nullif(w -> 'row' ->> 'fg_code', ''),
          nullif(w -> 'row' ->> 'product_name', '')
        );

      when 'update_sku_master' then
        update sku_master set
          new_fg_code  = case when jsonb_exists(w -> 'patch', 'new_fg_code')  then nullif(w -> 'patch' ->> 'new_fg_code', '')  else new_fg_code  end,
          product_name = case when jsonb_exists(w -> 'patch', 'product_name') then nullif(w -> 'patch' ->> 'product_name', '') else product_name end,
          mrp          = case when jsonb_exists(w -> 'patch', 'mrp')          then (w -> 'patch' ->> 'mrp')::numeric           else mrp          end
        where id = (w ->> 'id')::uuid;

      when 'update_mapper' then
        -- Scoped by mapper_set_id: unscoped, one edit rewrites every set that
        -- happens to share the SKU while the UI showed only one.
        update combo_mapper_rows set
          fg_code      = case when jsonb_exists(w -> 'patch', 'fg_code')      then nullif(w -> 'patch' ->> 'fg_code', '')      else fg_code      end,
          product_name = case when jsonb_exists(w -> 'patch', 'product_name') then nullif(w -> 'patch' ->> 'product_name', '') else product_name end,
          is_combo     = case when jsonb_exists(w -> 'patch', 'is_combo')     then (w -> 'patch' ->> 'is_combo')::boolean      else is_combo     end,
          products     = case when jsonb_exists(w -> 'patch', 'products')
                              then coalesce((select array_agg(value::text) from jsonb_array_elements_text(w -> 'patch' -> 'products')), '{}'::text[])
                              else products end
        where master_sku = w ->> 'masterSku'
          and mapper_set_id = (w ->> 'mapperSetId')::uuid;

      when 'delete_mapper' then
        delete from combo_mapper_rows
        where master_sku = w ->> 'masterSku'
          and mapper_set_id = (w ->> 'mapperSetId')::uuid;

      when 'delete_sku_master' then
        delete from sku_master where id = (w ->> 'id')::uuid;

      when 'retire_sku_master' then
        if coalesce((w ->> 'retire')::boolean, true) then
          update sku_master set is_active = false, discontinued_at = now() where id = (w ->> 'id')::uuid;
        else
          update sku_master set is_active = true, discontinued_at = null where id = (w ->> 'id')::uuid;
        end if;

      else
        raise exception 'apply_mapper_batch: unknown op %', w ->> 'op';
    end case;

    applied := applied + 1;
  end loop;

  -- row_count is displayed in three mapper pickers but almost no write path
  -- maintains it. Recount once per touched set, inside the same transaction, so it
  -- can never disagree with the rows it counts.
  for set_id in select (jsonb_array_elements_text(coalesce(payload -> 'mapperSetIds', '[]'::jsonb)))::uuid
  loop
    if set_id is not null and not (set_id = any(touched_sets)) then
      touched_sets := touched_sets || set_id;
      select count(*) into n from combo_mapper_rows where mapper_set_id = set_id;
      update combo_mapper_sets set row_count = n where id = set_id;
    end if;
  end loop;

  return jsonb_build_object('applied', applied, 'sets_recounted', array_length(touched_sets, 1));
end;
$func$;

-- Only the service role calls this (from the API route, after an admin check).
revoke all on function apply_mapper_batch(jsonb) from public;
revoke all on function apply_mapper_batch(jsonb) from anon;
revoke all on function apply_mapper_batch(jsonb) from authenticated;
