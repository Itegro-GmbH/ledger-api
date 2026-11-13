// Drizzle Kit config. Used by `pnpm db:generate` (`drizzle-kit generate`) and
// `pnpm db:generate:custom <name>` (`drizzle-kit generate --custom`, scripts/generate-custom.ts).
// `generate` diffs the schema against the last snapshot and needs no connection. Migrations are
// applied by scripts/migrate.ts (drizzle-orm's migrator), never by `drizzle-kit migrate`, but the
// migrations table is named here too so both agree: `ledger.__migrations`, inside the schema this
// service owns (decisions/0001-ledger-api.md: each side runs its own migrations with its own
// migration table).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  schemaFilter: ["ledger"],
  migrations: { schema: "ledger", table: "__migrations" },
});
