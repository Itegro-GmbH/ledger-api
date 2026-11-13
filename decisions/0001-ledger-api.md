# 0001: A multi-tenant bookkeeping core as an API

Document type: decision
Lifecycle: active
Owner: repository maintainers
Status: Proposed (2026-11-13; shared database instance decided the same day)
Scope: What this service is, its tenancy model, stack and hosting, the operation catalog, the
first two platforms (Digipost and reserwirt), the DATEV export, and how the existing ledger moves
here from Digipost

## Context

Itegro built a double-entry ledger inside Digipost (Digipost decisions/0080, `src/modules/ledger`,
PRs #18 to #22). It keeps Itegro's own books and was validated against the tax advisor's figures
for several months (bank balance to the cent per month, VAT returns identical, the
known differences explained). It is a strong domain core, but it lives inside one product, is
scoped to a Digipost workspace and reads Digipost's own tables.

Two needs point past Digipost:

1. **Bookkeeping software exists; a German bookkeeping core for developers does not.** Generic
   ledger APIs (Modern Treasury Ledgers, Formance, Blnk) know double entry but no SKR, no VAT
   return, no GoBD, no DATEV. German accounting products with an API (Lexware Office, sevDesk,
   DATEV) are applications that own their customers, not a core to build into one's own product.
   US "embedded accounting" (Layer, Teal) shows the shape; a German equivalent is the gap.
2. **reserwirt needs it now.** reserwirt is a reservation platform for restaurants ("Wirte").
   For each Wirt it issues invoices to guests in the Wirt's name (several VAT rates per invoice),
   invoices the Wirt for its own platform fee, and runs payments through Stripe Connect with
   direct charges: the money is charged on the Wirt's own Stripe account, reserwirt takes an
   application fee and never holds the money. Each Wirt wants a DATEV CSV for their tax advisor.

Bookkeeping, the VAT logic and the controls are the same in both cases. Only the sources differ:
documents and bank statements in Digipost, invoices and Stripe balance transactions in reserwirt.

## Decision

### What the service is

`ledger-api` is a multi-tenant bookkeeping core reached only through an API: double-entry
journal, chart of accounts (SKR04 and SKR03 templates), VAT codes and the VAT return's
Kennzahlen, open items with flexible clearing accounts, booking rules and proposals, controls,
period locking by filing, a full revision history, and the DATEV export. It has no end-user UI.
A product that needs one (Digipost) builds it on the API.

### Tenancy: platform and tenant

- A **platform** is an API customer: a software product that keeps books for its own customers
  (Digipost, reserwirt). It holds API keys and owns tenants. It sees only its own tenants.
- A **tenant** ("Mandant") is one set of books: one company or sole trader with its own chart,
  settings, DATEV consultant and client number, and fiscal year. Every bookkeeping row carries
  `tenant_id` and cascades from it.
- A platform can also be a tenant of itself (reserwirt keeps its own books next to its Wirte's).
- Test and live are separate by key (`sk_test_...`, `sk_live_...`) and by an `environment`
  column on platforms' tenants, not by another level.

Words avoided on purpose: `account` (collides with ledger accounts), `client` (OAuth clients),
`workspace` (Digipost's own concept, which maps to a tenant).

### Stack and hosting

- **TypeScript on Node 24**, because the validated domain code is TypeScript and is moved, not
  rewritten.
- **Hono** with `@hono/zod-openapi` for HTTP; the MCP endpoint (`@modelcontextprotocol/sdk`,
  Streamable HTTP) runs in the same app under `/mcp`.
- **Vercel**, Fluid compute, region `fra1` (all processing in Frankfurt), one function for API
  and MCP. Serverless by owner decision; Cloudflare Workers was considered and set aside because
  processing cannot be pinned to the EU without an enterprise contract and Postgres needs
  Hyperdrive. Hono keeps the move possible: everything platform-specific (database pool, job
  trigger, file storage) sits behind small adapters.
- **Neon Postgres in an EU region**, Drizzle, a normal connection pool (real transactions; the
  HTTP driver cannot run the booking use cases). The balance and filing-lock triggers move with
  the schema: the database itself refuses an unbalanced entry or a change in a locked period.
- **One database instance shared with Digipost, two schemas** (owner decision 2026-11-13):
  this service owns the Postgres schema `ledger`, Digipost keeps `public` for its product data.
  Each side connects with its own role that can only use its own schema, and runs its own
  migrations with its own migration table. Digipost reads and writes bookkeeping data only
  through the API, never by SQL. One instance means one backup and one bill; the clean boundary
  means `ledger` can move to an instance of its own later with a dump of one schema.
- **Background work without a worker**: a jobs table in Postgres, a cron endpoint that drains it,
  and an immediate kick after enqueueing (the pattern Digipost runs today). Vercel Queues only
  if load requires it.
- **Files** (exports, receipts) in S3-compatible storage in the EU.

### Repository layout

```
apps/api/             Hono app: HTTP API, MCP, cron and job endpoints (deployed to Vercel)
packages/core/        pure bookkeeping logic, no I/O (from Digipost src/modules/ledger/core)
packages/db/          Drizzle schema, migrations, SQL triggers, repositories
packages/operations/  the operation catalog (see below)
packages/sdk/         TypeScript client generated from the OpenAPI document
decisions/            ADRs
```

### One operation catalog, three surfaces

Every capability is defined once, like Digipost's MCP tools: name, description, Zod input,
required scope, effect (`read`, `write`, `destructive`), idempotency, handler. From that one
definition come:

1. **HTTP**: `POST /v1/<operation_name>` with a JSON body, JSON answer
   `{ ok: true, data }` or `{ ok: false, error: { code, details } }` with stable error codes.
   RPC style on purpose: one verb per capability, the same name as the MCP tool, no mapping of
   bookkeeping actions onto REST resources.
2. **OpenAPI** generated from the catalog, so documentation cannot drift.
3. **MCP** tools with the same names and descriptions, for agents.

Names are `snake_case` everywhere (some MCP clients reject dots).

Request conventions:

- `Authorization: Bearer sk_live_...`: a platform key, stored hashed, with scopes `read`,
  `write`, `filing` (locking a period is its own scope).
- `Ledger-Tenant: ten_...`: the tenant to act in. The service checks in exactly one place that
  it belongs to the key's platform; a foreign or unknown tenant is answered `tenant_not_found`.
- `Ledger-Actor: <free text>`: who acted on the platform's side (a user id or email), recorded in
  revisions (`booked_by`, `changed_by`). The service has no end users of its own.
- `Idempotency-Key` required on every `write` and `destructive` operation: the same key with the
  same body returns the stored answer, with a different body `idempotency_conflict`. Sources
  additionally carry their own external id (a document id, a Stripe balance transaction id), so
  sending the same source twice never books twice, even without the header.

### What the service owns, and what platforms send

Everything about money and booking lives here, once. A platform keeps only its own product data
(for Digipost: users, workspaces, the document files and their processing) and sends the rest:

| Data | Owned here as | Operations | Digipost | reserwirt |
|---|---|---|---|---|
| Counterparties | Name, country, VAT id, IBAN, payment aliases, verification state | `upsert_counterparties`, `list_counterparties`, `merge_counterparties` | Its contacts move here entirely | reserwirt itself as supplier; guests are not needed |
| Money accounts | Bank accounts, payment-provider balances, platform clearing accounts | `create_money_account`, `list_money_accounts`, ... | Its bank and clearing accounts move here | The Wirt's Stripe balance |
| Money movements | One movement on such an account: date, amount, counterparty, text, type, payout grouping | `import_bank_statement` (camt.053), `upsert_money_movements`, `list_money_movements` | Its bank transactions, import batches and settlement lines move here; statements are imported through the API | Stripe balance transactions (charge, application fee, refund, dispute, payout, and a Stripe fee if one ever appears) |
| Movement to document links | Which document a movement pays, with the allocated amount | `link_movement_documents`, `unlink_movement_document`, `set_no_document_needed` | Confirmed payment matches; the matching itself (suggestions, AI arbiter, rejections) stays in Digipost, next to the documents it reads | Charge to invoice via the Stripe charge id |
| Documents (accounting view) | Direction, number, dates, service period, totals, tax breakdown per rate, pass-through, reverse charge, counterparty, a link to the file | `upsert_documents` | Sent after analysis; file, OCR text and the processing pipeline stay in Digipost | Invoices issued in the Wirt's name, reserwirt's fee invoices |

A source is never interpreted as a booking by itself. Templates and booking rules turn it into a
proposal; a rule says, for example, "movement type `application_fee` books to Provisionen with
input tax 19 %". Rules are data per platform with per-tenant overrides, so a changed fee model
(today reserwirt absorbs the Stripe fee through a higher application fee) changes rules, not
code. Movements are booked as they happened on the Stripe account, so a fee that appears there is
booked, and one that does not is not.

### The operation catalog, first version

Read (`read` scope): `get_overview`, `list_entries`, `get_entry`, `list_accounts`,
`get_balances`, `get_account_sheet`, `get_open_items`, `get_vat_preview`, `list_rules`,
`list_periods`, `get_advisor_comparison`, `list_counterparties`, `list_money_accounts`,
`list_money_movements`, `list_documents`, `get_export`.

Write (`write` scope): `create_tenant`, `update_tenant`, the counterparty, money and document
operations (above), `sync_proposals`,
`create_entry`, `update_entry`, `book_entries`, `unbook_entry`, `dismiss_proposal`,
`restore_proposal`, `create_account`, `update_account`, `set_account_archived`,
`create_open_item_match`, `create_rule`, `update_rule`, `learn_rule_from_entry`,
`create_filing` (draft only), `create_correction_filing`, `create_handover`,
`import_advisor_balances`, `create_datev_export`.

Destructive: `delete_tenant`, `delete_entry`, `delete_open_item_match`, `delete_rule`, `delete_advisor_balances`,
`submit_filing` (`filing` scope; locks the period for good, as in Digipost).

These are Digipost's 34 MCP ledger tools renamed for tenancy, plus tenants, the money and
counterparty data that moves from Digipost, documents and the export.

### Tenant settings that matter for Germany

Chart (`skr04` or `skr03`), VAT period and basis (Soll or Ist), books start date, fiscal year
start, DATEV consultant number, client number and account length, and per tenant the accounts
for the platform's clearing account and its document number range. The account numbers the
engine uses (payables, receivables, money in transit, default revenue per rate) come from the
chart template, never from constants in code.

### DATEV export

`create_datev_export` produces, per tenant and period, a DATEV "Buchungsstapel" (EXTF CSV,
Windows-1252, semicolon) with the header DATEV requires (consultant and client number, fiscal
year start, account length, date range, description, `Festschreibung` 0 so the advisor can still
correct) and one row per booking pair:

- An entry with several lines is split into rows of account and contra account around its money
  or open-item line.
- Tax is not exported as separate lines: the gross amount goes on the revenue or expense account
  with the DATEV tax key (BU-Schlüssel) of the line's tax code, so the advisor's DATEV computes
  the VAT return itself. The tax-code to BU-key table is per chart and must be confirmed with a
  tax advisor before the first real export.
- `Belegfeld 1` carries the document number, the booking text the counterparty and number.
  Receipts go in a ZIP next to the CSV (DATEV document images, `document.xml`, later).
- The export only contains what the platform's sources produced. A Wirt's advisor keeps booking
  the cash register, suppliers and the bank statement; the export ends at the platform's clearing
  account by default, and the payout list lets the advisor book the bank line "Stripe payout"
  against it. A tenant setting can include the payout booking instead, for an advisor who wants
  that (never both, or the payout is booked twice).

The exact header and column layout is taken from DATEV's current interface description when
implemented, not from memory, and tested against a sample import in DATEV.

### reserwirt, booking by example

A guest pays 110,00 for a set menu (food 80,00 at 7 %, drinks 30,00 at 19 %) through Stripe on
the Wirt's account; reserwirt's application fee is 8,45 gross (7,10 + 19 % VAT).

| Event | Debit | Credit |
|---|---|---|
| Invoice in the Wirt's name, paid | Stripe clearing 110,00 | Revenue 7 % 74,77, VAT 5,23; revenue 19 % 25,21, VAT 4,79 |
| reserwirt fee invoice | Commission 7,10, input tax 1,35 | Stripe clearing 8,45 |
| Payout | Bank 101,55 | Stripe clearing 101,55 |

The Stripe clearing account is back at zero. Refunds reverse revenue and VAT against the clearing
account; disputes and their fees likewise. reserwirt's own books (a tenant of its own): the
application fee as revenue with 19 % VAT, the Stripe fee it absorbs as an expense.

Requirements on reserwirt's side that follow: the application fee must be gross including VAT,
and reserwirt must issue an invoice for it (a monthly summary invoice per Wirt is enough), or the
Wirt has no receipt for the input tax.

### Moving Digipost's ledger here, keeping today's state

Owner decisions: keep the current production state (Itegro's booked entries, rules, matches,
revisions, and the bank data behind them), use the very same database instance, and make
Digipost a UI on the API. No data is copied.

1. **Build against the existing tables.** This repository's schema starts from Digipost's
   ledger migrations (`0028`, `0029`, `0030`, `0032`, `0033`) and the tables of Digipost's
   accounts, contacts and payments modules that move here (`accounts`, `transactions`,
   `import_batches`, `settlement_lines`, `contacts`, `payment_aliases`,
   `payment_no_document_rules`, `document_transactions`), with `tenant_id` in place of
   `workspace_id` and `tenants` in place of the foreign keys to Digipost's `workspaces`. The
   triggers stay unchanged. New tables: platforms, tenants, API keys, idempotency keys, jobs,
   exports. Digipost's migration history is not copied.
2. **The switch is one adoption migration, not a copy.** It runs once against the shared
   instance and only moves structure:
   - creates schema `ledger` and the two roles (the API's role sees only `ledger`, Digipost's
     only `public`);
   - moves the tables above with `ALTER TABLE ... SET SCHEMA ledger` (metadata only: rows, ids,
     indexes and triggers stay as they are);
   - creates platform `digipost` and one tenant per workspace that has such data, with
     `tenant.id = workspace.id`, renames `workspace_id` to `tenant_id` and swaps the foreign
     keys from `workspaces` to `tenants`;
   - records itself in this repository's migration table, so later migrations build on it.
   Every id is kept, so Digipost's documents, document-contact links and payment suggestions
   still point at the right rows. Running it against production needs the owner's explicit
   approval in the chat at that time.
3. **Digipost switches in the same release.** Its ledger pages, finance pages (accounts,
   transactions, statement import, open items) and its MCP finance and ledger tools call the SDK
   instead of in-process use cases; its own tables that stay (documents, users, workspaces,
   matching suggestions and rejections, contact change proposals) reference the moved rows by
   plain id. Digipost keeps its permission checks (`finance.read`, `finance.manage`) and passes
   the acting user as `Ledger-Actor`. After analysis, a document's accounting fields are sent
   with `upsert_documents` from an outbox, with a one-time backfill.
4. **Verified on both sides of the switch.** Before and after the adoption migration, balances
   per account, the VAT preview for every quarter already booked, open items, bank
   comparisons and controls must be identical; a rehearsal runs first on a Neon branch of
   production.
5. **Workspace deletion** no longer cascades into these tables by foreign key: Digipost calls
   `delete_tenant` in the same flow (Digipost decisions/0027 is updated accordingly).
6. **Moving contacts is the largest step**, because Digipost's documents use them everywhere
   (recognition, verification, the no-silent-overwrite rule). Which parts of that workflow stay
   in Digipost and call the API is settled in Digipost's own ADR for the switch.

The AI booking advisor (Mistral) moves with the engine as an optional, per-platform provider.
It sends invoice data to Mistral, so the same data-protection condition as in Digipost applies:
no real customer data through it before a DPA exists; reserwirt starts with templates and rules
only.

### Phases

1. **Core API**: repository, CI, Vercel and Neon set up; `packages/core` and `packages/db` moved
   from Digipost with their tests; platforms, tenants, keys, idempotency; the operation catalog
   for reads, entries, rules, open items, filings; HTTP, OpenAPI, MCP; SDK.
2. **Digipost switch**: counterparties, money accounts and movements, statement import as
   operations; the adoption migration rehearsed on a Neon branch, then run; Digipost's finance
   and ledger UI and MCP tools on the SDK.
3. **DATEV export**: SKR03 template, BU-key table, EXTF writer, test import with an advisor.
4. **reserwirt**: Stripe Connect movements and invoices as sources, fee rules, one Wirt in test,
   then live.
5. Later: Stripe pull connector (the service reads balance transactions itself with a restricted
   key), DATEV document images, ELSTER submission of the VAT return (ERiC), GoBD process
   documentation and an IDW PS 880 review.

Phase 3 does not depend on phase 2 and can run in parallel if reserwirt is more urgent.

## Consequences

- Digipost's ledger code stops evolving in Digipost; fixes land here and reach Digipost through
  the SDK. Until phase 2 is done, both exist and changes must be ported by hand.
- A second deployment and secret set to run, and an API contract to keep stable (`/v1`,
  additive changes only, a new version for breaking ones). Still one database instance.
- Digipost shrinks to users, workspaces and document processing; its accounts, contacts and
  payments modules become UI and matching logic on the API. Bank data exists once, for every
  platform, in the same tables.
- Other platforms' books (reserwirt's Wirte) live in the same instance as Digipost's product
  data, separated by schema and role. Moving `ledger` to its own instance is the planned answer
  once that matters (load, a customer's contract, a certification).
- GoBD responsibility grows: as the bookkeeping core of other companies' software, this service
  becomes part of their process documentation. Append-only revisions, period locking and an
  export log are in from the start; the formal documentation follows in phase 5.
- Tax correctness stays a shared responsibility: the service computes, it does not advise. The
  terms of use say so, and per-platform rules (reserwirt's VAT treatment of deposits, vouchers,
  no-show fees, Stripe fees) are confirmed by a tax advisor before going live.

## Open questions

- Tax treatment for reserwirt to confirm with a tax advisor: deposits and prepayments (VAT due on
  receipt), single-purpose and multi-purpose vouchers, no-show and cancellation fees, Stripe's
  fees (treated as VAT-exempt financial services from Ireland, no reverse charge).
- Which charts the Wirte's advisors use (SKR03 is common in gastronomy) and whether they know
  their DATEV consultant and client numbers.
- Pricing of the API (per tenant and month is the working assumption).
- Whether Itegro's tax advisor accepts a DATEV import from this service; her answer also
  settles the BU-key table for SKR04.
