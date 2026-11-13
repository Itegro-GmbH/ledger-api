
## Adopting a Digipost workspace

`scripts/adopt-digipost-workspace.sql` copies one Digipost workspace's bookkeeping and source rows
from schema `public` into schema `ledger` of the same database, in one transaction, keeping every
id (decisions/0001-ledger-api.md, "Production setup"). It refuses to run twice and aborts on any
row-count difference. Rehearse it first on a local restore of a production backup:

```sh
docker run --rm -d --name adopt-rehearsal -e POSTGRES_USER=neondb_owner -e POSTGRES_PASSWORD=x \
  -e POSTGRES_DB=neondb -p 55440:5432 -v <backup dir>:/backups:ro postgres:18
docker exec adopt-rehearsal pg_restore -U neondb_owner -d neondb --no-owner --no-privileges /backups/<dump>
# create role ledger_api and schema ledger, run pnpm db:migrate as ledger_api, insert the platform,
# grant the copying role usage plus select/insert/update on schema ledger, then:
psql ... -v workspace=<uuid> -v platform=<uuid> -v environment=live -f scripts/adopt-digipost-workspace.sql
```

Afterwards compare the VAT previews, the bank comparison and the controls through the API with
what Digipost shows; they must be identical.
