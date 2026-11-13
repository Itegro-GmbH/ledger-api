-- Source for the custom migration locking what a filing reached the tax office with
-- (Digipost decisions/0080-ledger-double-entry-bookkeeping.md "Editable until filed";
-- decisions/0001-ledger-api.md keeps it). Turned into a real migration file by
-- `pnpm db:generate:custom ledger_filing_lock` (packages/db/scripts/generate-custom.ts); never
-- edit the generated migration file directly. Everything lives in the schema `ledger`.
--
-- A booked journal entry is locked when its booking date lies inside the period of a submitted
-- filing: a submitted USt-VA (`vat_return`) locks its period, a submitted annual statement
-- (`annual_statement`) locks every day of the years it covers. A locked entry, and each of its
-- lines, can be neither updated nor deleted, and no booked entry can be inserted into (or moved
-- into, or booked inside) a locked period. Proposals stay editable: only `booked` counts.
--
-- Exceptions, in both cases recognized by the data, not by a session flag anyone could set:
--
-- 1. The tenant-deletion cascade (deleting a `tenants` row, or its platform): its DELETEs run
--    after the parent `tenants` row is gone in the same statement, so the row being deleted no
--    longer has a tenant.
-- 2. A correction: an entry whose `filing_id` names a DRAFT filing that corrects another filing
--    (`corrects_filing_id` set) of the same kind, covering the entry's booking date, may change
--    despite a submitted filing of that kind. Once the correction is submitted it locks those
--    entries like any other filing. An update is judged by the NEW `filing_id`, so tying an entry
--    of the period to the draft correction is itself the deliberate act that opens it.
--
-- A submitted filing is itself frozen (no update, no delete except the cascade): undoing it
-- would silently unlock the period. Every refusal is `raise exception 'ledger_locked'`
-- (SQLSTATE P0001), mapped to `locked` by the ledger use case.

create or replace function ledger.ledger_filing_covers(p_kind text, p_from date, p_to date, p_date date) returns boolean
language sql
immutable
as $$
  select case
    when p_kind = 'annual_statement' then
      p_date between date_trunc('year', p_from)::date and (date_trunc('year', p_to) + interval '1 year' - interval '1 day')::date
    else p_date between p_from and p_to
  end;
$$;

create or replace function ledger.ledger_date_locked(p_tenant uuid, p_date date, p_filing uuid) returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from ledger.ledger_filings f
    where f.tenant_id = p_tenant
      and f.status = 'submitted'
      and ledger.ledger_filing_covers(f.kind, f.period_from, f.period_to, p_date)
      and not exists (
        select 1
        from ledger.ledger_filings d
        where p_filing is not null
          and d.id = p_filing
          and d.tenant_id = p_tenant
          and d.status = 'draft'
          and d.corrects_filing_id is not null
          and d.kind = f.kind
          and ledger.ledger_filing_covers(d.kind, d.period_from, d.period_to, p_date)
      )
  );
$$;

create or replace function ledger.ledger_entries_refuse_locked() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from ledger.tenants where id = old.tenant_id) then
      return old;
    end if;
    if old.status = 'booked' and ledger.ledger_date_locked(old.tenant_id, old.booking_date, old.filing_id) then
      raise exception 'ledger_locked' using detail = format('journal entry %s is part of a submitted filing', old.id);
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.status = 'booked' and ledger.ledger_date_locked(old.tenant_id, old.booking_date, new.filing_id) then
    raise exception 'ledger_locked' using detail = format('journal entry %s is part of a submitted filing', old.id);
  end if;
  if new.status = 'booked' and ledger.ledger_date_locked(new.tenant_id, new.booking_date, new.filing_id) then
    raise exception 'ledger_locked' using detail = format('%s lies inside a submitted filing period', new.booking_date);
  end if;
  return new;
end;
$$;

create or replace function ledger.ledger_lines_refuse_locked() returns trigger
language plpgsql
as $$
declare
  v_entry record;
begin
  if tg_op = 'DELETE' and not exists (select 1 from ledger.tenants where id = old.tenant_id) then
    return old;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select tenant_id, status, booking_date, filing_id into v_entry from ledger.journal_entries where id = old.entry_id;
    if found and v_entry.status = 'booked' and ledger.ledger_date_locked(v_entry.tenant_id, v_entry.booking_date, v_entry.filing_id) then
      raise exception 'ledger_locked' using detail = format('journal entry %s is part of a submitted filing', old.entry_id);
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select tenant_id, status, booking_date, filing_id into v_entry from ledger.journal_entries where id = new.entry_id;
    if found and v_entry.status = 'booked' and ledger.ledger_date_locked(v_entry.tenant_id, v_entry.booking_date, v_entry.filing_id) then
      raise exception 'ledger_locked' using detail = format('journal entry %s is part of a submitted filing', new.entry_id);
    end if;
    return new;
  end if;
  return old;
end;
$$;

create or replace function ledger.ledger_filings_refuse_change() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from ledger.tenants where id = old.tenant_id) then
      return old;
    end if;
    if old.status = 'submitted' then
      raise exception 'ledger_locked' using detail = format('filing %s was submitted', old.id);
    end if;
    return old;
  end if;
  if old.status = 'submitted' then
    raise exception 'ledger_locked' using detail = format('filing %s was submitted', old.id);
  end if;
  return new;
end;
$$;

create trigger journal_entries_filing_lock
  before insert or update or delete on ledger.journal_entries
  for each row execute function ledger.ledger_entries_refuse_locked();

create trigger journal_lines_filing_lock
  before insert or update or delete on ledger.journal_lines
  for each row execute function ledger.ledger_lines_refuse_locked();

create trigger ledger_filings_frozen
  before update or delete on ledger.ledger_filings
  for each row execute function ledger.ledger_filings_refuse_change();
