# ledger-api

A multi-tenant German bookkeeping core, reached only through an API: double-entry journal,
SKR04/SKR03 charts, VAT codes and the VAT return, open items and clearing accounts, booking rules
and proposals, period locking, revisions, and the DATEV export.

Platforms (software products such as Digipost and reserwirt) keep books for their own customers,
the tenants ("Mandanten"). Every capability is one operation, reachable as `POST /v1/<name>`,
documented through OpenAPI and offered as an MCP tool under the same name.

- Concept: [decisions/0001-ledger-api.md](decisions/0001-ledger-api.md)
- Production: https://ledger-api-rho.vercel.app (`/health`, `/openapi.json`)

## Develop

```sh
pnpm install
pnpm dev        # http://localhost:8787
pnpm verify     # typecheck, lint, unit tests
pnpm build      # Vercel Build Output in .vercel/output
```

```sh
curl -s -X POST localhost:8787/v1/list_tax_codes -H 'content-type: application/json' -d '{}'
```

Database (`packages/db`, Postgres schema `ledger`):

```sh
pnpm db:generate                     # migration from a schema change (drizzle-kit)
pnpm db:generate:custom <name>       # custom migration from packages/db/sql/<name>/<name>.sql
DATABASE_URL=... pnpm db:migrate     # apply migrations (never a shared database without approval)

docker run --rm -d --name ledger-test-pg -e POSTGRES_USER=ledger -e POSTGRES_PASSWORD=ledger \
  -e POSTGRES_DB=ledger_test -p 55432:5432 postgres:17
TEST_DATABASE_URL=postgres://ledger:ledger@localhost:55432/ledger_test pnpm test:db
```

Status: phase 1 in progress. Reference data is live; tenants, keys and bookings follow with the
database layer.
