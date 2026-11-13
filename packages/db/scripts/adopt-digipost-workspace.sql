-- One-time switch of a Digipost workspace onto this service (decisions/0001-ledger-api.md,
-- "Production setup"): copies the workspace's bookkeeping and source rows from Digipost's
-- tables in schema `public` into this service's tables in schema `ledger`, in the SAME database,
-- in ONE transaction, keeping every id. The tenant gets the workspace's id. The balance and
-- filing-lock triggers stay active, so an inconsistent row fails the whole copy. Digipost's own
-- rows are only read, never changed or deleted.
--
-- Run as a role that can read the `public` tables and write the `ledger` tables:
--   psql "$URL" -v ON_ERROR_STOP=1 -v workspace=<workspace uuid> -v platform=<digipost platform uuid> \
--        -v environment=live -f adopt-digipost-workspace.sql
-- It refuses to run when the tenant already exists. The last statement prints the row counts of
-- both sides; the transaction is committed only if every count matches.

\set ON_ERROR_STOP 1
begin;

select set_config('adopt.workspace', :'workspace', true), set_config('adopt.platform', :'platform', true), set_config('adopt.environment', :'environment', true);

do $$
declare
  ws uuid := current_setting('adopt.workspace')::uuid;
  platform uuid := current_setting('adopt.platform')::uuid;
  env text := current_setting('adopt.environment');
  tbl text;
  cols text;
  vals text;
  -- Order respects the foreign keys inside `ledger`.
  tables text[] := array[
    'contacts', 'accounts', 'import_batches', 'transactions', 'settlement_lines',
    'document_transactions', 'payment_aliases', 'payment_no_document_rules',
    'ledger_settings', 'ledger_accounts', 'ledger_filings', 'journal_entries', 'journal_lines',
    'journal_entry_revisions', 'ledger_open_item_matches', 'ledger_open_item_match_lines',
    'ledger_booking_rules', 'ledger_handovers', 'ledger_advisor_balances', 'ledger_advisor_balance_lines',
    'ledger_booking_advice'
  ];
begin
  if exists (select 1 from ledger.tenants where id = ws) then
    raise exception 'tenant % exists already: nothing copied', ws;
  end if;
  if not exists (select 1 from ledger.platforms where id = platform) then
    raise exception 'platform % does not exist', platform;
  end if;

  insert into ledger.tenants (id, platform_id, environment, name, external_ref)
  select w.id, platform, env, w.name, 'digipost-workspace:' || w.id from public.workspaces w where w.id = ws;
  if not found then
    raise exception 'workspace % not found', ws;
  end if;

  -- Documents first (their accounting view): `ledger.documents` has its own shape. The date a
  -- report or statement is booked on is its effective date in Digipost, kept as document date.
  insert into ledger.documents (
    id, tenant_id, kind, direction, title, sender, summary, original_file_name, invoice_number,
    document_date, service_date, service_period_from, service_period_to, currency,
    total_amount_cents, net_total_cents, tax_total_cents, pass_through_cents, tax_breakdown,
    reverse_charge, platform, contact_id, created_at, updated_at
  )
  select d.id, d.workspace_id, coalesce(d.manual_kind, d.kind), d.direction, d.title, d.sender, d.summary,
    d.original_file_name, d.invoice_number,
    -- Digipost's `documentEffectiveDate`: own date, else an app store report's month end, else a
    -- statement's last booking, else the day it arrived.
    coalesce(
      d.document_date,
      case when d.intake_result->'appStorePayout'->>'period' ~ '^[0-9]{4}-[0-9]{2}$'
        then (to_date((d.intake_result->'appStorePayout'->>'period') || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date end,
      case when d.intake_result->>'lastBookingDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (d.intake_result->>'lastBookingDate')::date end,
      d.created_at::date),
    d.service_date, d.service_period_from, d.service_period_to, d.currency,
    d.total_amount_cents, d.net_total_cents, d.tax_total_cents, d.pass_through_cents, d.tax_breakdown,
    d.reverse_charge, d.platform, null, d.created_at, d.updated_at
  from public.documents d where d.workspace_id = ws;

  foreach tbl in array tables loop
    -- Every column the target has: `tenant_id` from `workspace_id`, the rest by name, cast to
    -- the target's type (the actor columns are text here, uuid in Digipost).
    select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position),
           string_agg(case when c.column_name = 'tenant_id' then 's.workspace_id'
                           else format('s.%I::%s', c.column_name, c.udt_name) end, ', ' order by c.ordinal_position)
      into cols, vals
    from information_schema.columns c
    where c.table_schema = 'ledger' and c.table_name = tbl
      and (c.column_name = 'tenant_id' or exists (
        select 1 from information_schema.columns p
        where p.table_schema = 'public' and p.table_name = tbl and p.column_name = c.column_name));
    execute format('insert into ledger.%I (%s) select %s from public.%I s where s.workspace_id = $1', tbl, cols, vals, tbl) using ws;
  end loop;

  -- The counterparty of each document: Digipost links it through `document_contacts`; here it is
  -- one column. Same choice as Digipost's ledger read: the oldest link in the document's role.
  update ledger.documents ld set contact_id = (
    select dc.contact_id from public.document_contacts dc join public.documents d on d.id = dc.document_id
    where dc.document_id = ld.id
      and dc.role = case when d.direction = 'outgoing' then 'recipient' else 'sender' end
    order by dc.created_at limit 1)
  where ld.tenant_id = ws;
end $$;

-- Row counts, both sides; any difference aborts.
do $$
declare
  ws uuid := current_setting('adopt.workspace')::uuid;
  tbl text;
  a bigint;
  b bigint;
  report text := '';
begin
  foreach tbl in array array['documents', 'contacts', 'accounts', 'import_batches', 'transactions', 'settlement_lines',
    'document_transactions', 'payment_aliases', 'payment_no_document_rules', 'ledger_settings', 'ledger_accounts',
    'ledger_filings', 'journal_entries', 'journal_lines', 'journal_entry_revisions', 'ledger_open_item_matches',
    'ledger_open_item_match_lines', 'ledger_booking_rules', 'ledger_handovers', 'ledger_advisor_balances',
    'ledger_advisor_balance_lines', 'ledger_booking_advice'] loop
    execute format('select count(*) from public.%I where workspace_id = $1', tbl) into a using ws;
    execute format('select count(*) from ledger.%I where tenant_id = $1', tbl) into b using ws;
    report := report || format('%s %s/%s; ', tbl, a, b);
    if a <> b then
      raise exception 'count mismatch on %: public % vs ledger %', tbl, a, b;
    end if;
  end loop;
  raise notice 'adopted: %', report;
end $$;

commit;
