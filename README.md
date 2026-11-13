# ledger-api

A multi-tenant German bookkeeping core, reached only through an API: double-entry journal,
SKR04/SKR03 charts, VAT codes and the VAT return, open items and clearing accounts, booking rules
and proposals, period locking, revisions, and the DATEV export.

Platforms (software products such as Digipost and reserwirt) keep books for their own customers,
the tenants ("Mandanten"). Every capability is one operation, reachable as `POST /v1/<name>`,
documented through OpenAPI and offered as an MCP tool under the same name.

Status: concept. Start with [decisions/0001-ledger-api.md](decisions/0001-ledger-api.md).
