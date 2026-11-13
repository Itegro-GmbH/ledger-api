// Builds the Vercel deployment with the Build Output API (v3): the app bundled by esbuild into
// one ES module, so workspace packages written in TypeScript need no build step of their own.
// Output: <repo root>/.vercel/output, deployed with `vercel deploy --prebuilt`.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(appDir, "..", "..", ".vercel", "output");
const fn = join(output, "functions", "index.func");

await rm(output, { recursive: true, force: true });
await mkdir(fn, { recursive: true });

await build({
  entryPoints: [join(appDir, "src", "vercel.ts")],
  outfile: join(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  // CommonJS dependencies bundled into ESM still call require(); give them one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "info",
});

await writeFile(
  join(fn, ".vc-config.json"),
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, regions: ["fra1"], maxDuration: 60 }, null, 2),
);
await writeFile(join(fn, "package.json"), JSON.stringify({ type: "module" }));
await writeFile(join(output, "config.json"), JSON.stringify({ version: 3, routes: [{ src: "/(.*)", dest: "/index" }] }, null, 2));
console.log(`built ${output}`);
