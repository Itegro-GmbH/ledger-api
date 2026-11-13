// pnpm db:generate:custom <name>
//
// For custom SQL Drizzle cannot express from the schema alone (functions, triggers). The source
// lives at packages/db/sql/<name>/<name>.sql (reviewable on its own, independent of drizzle-kit's
// output naming); this script:
//   1. runs `drizzle-kit generate --custom --name <name>` to create an empty, properly ordered
//      migration file and journal entry;
//   2. copies the source file's contents into that generated migration file.
//
// Re-running with the same `<name>` after editing the source does NOT update an already generated
// migration (migrations are immutable once committed): a change is a new custom migration.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
  console.error("usage: pnpm db:generate:custom <name>  (lowercase snake_case)");
  process.exit(2);
}

const sourceFile = join(ROOT, "sql", name, `${name}.sql`);
if (!existsSync(sourceFile)) {
  console.error(`Missing source file: packages/db/sql/${name}/${name}.sql - write the SQL there first.`);
  process.exit(2);
}

const migrationsDir = join(ROOT, "migrations");
const before = new Set(readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")));

execFileSync("pnpm", ["exec", "drizzle-kit", "generate", "--custom", `--name=${name}`], { cwd: ROOT, stdio: "inherit" });

const created = readdirSync(migrationsDir).find((file) => !before.has(file) && file.endsWith(`${name}.sql`));
if (!created) {
  console.error(`Could not find the newly generated migration file (expected one ending in "${name}.sql").`);
  process.exit(1);
}
writeFileSync(join(migrationsDir, created), readFileSync(sourceFile, "utf8"));
console.log(`Copied packages/db/sql/${name}/${name}.sql into packages/db/migrations/${created}`);
