// The DATEV export end to end through HTTP: settings, two booked entries, the file.
import { randomUUID } from "node:crypto";

import { createDrizzleRepositories } from "@ledger/db";
import { describe, expect, it } from "vitest";

import { useTestDb } from "../../../packages/db/tests/support/test-database";
import { createApp } from "../src/app";
import { createDatabaseDeps } from "../src/composition";

const { db, pool } = useTestDb();
const app = createApp(createDatabaseDeps(pool));
const repos = createDrizzleRepositories(db);

type Body = { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };

describe("the DATEV export", () => {
  it("exports booked entries as a Windows-1252 Buchungsstapel with the tenant's numbers", async () => {
    const platform = await repos.platform.create({ name: `Plattform ${randomUUID()}` });
    const { secret } = await repos.apiKey.create({ platformId: platform.id, environment: "test", name: "test", scopes: ["read", "write"] });
    const call = async (operation: string, input: unknown, tenant?: string): Promise<Body> =>
      (await (
        await app.request(`/v1/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "idempotency-key": randomUUID(), ...(tenant ? { "ledger-tenant": tenant } : {}) },
          body: JSON.stringify(input),
        })
      ).json()) as Body;

    const tenantId = ((await call("create_tenant", { name: "Gasthaus Muster" })).data!.tenant as { id: string }).id;
    expect((await call("create_datev_export", { from: "2026-07-01", to: "2026-07-31" }, tenantId)).error?.code).toBe("datev_settings_missing");

    const settings = await call("set_datev_settings", { consultantNumber: 1001, clientNumber: 10001 }, tenantId);
    expect(settings.data!.datev).toMatchObject({ consultantNumber: 1001, clientNumber: 10001, accountLength: 4, fiscalYearStartMonth: 1 });

    await call("create_entry", { entry: { bookingDate: "2026-07-15", text: "Getränke für Gäste", lines: [{ accountNumber: "6810", amountCents: 1190, taxCode: "vst19" }, { accountNumber: "3300", amountCents: -1190 }] }, book: true }, tenantId);
    await call("create_entry", { entry: { bookingDate: "2026-07-20", text: "Menü", lines: [{ accountNumber: "1200", amountCents: 11000 }, { accountNumber: "4300", amountCents: -8000, taxCode: "ust7" }, { accountNumber: "4400", amountCents: -3000, taxCode: "ust19" }] }, book: true }, tenantId);
    await call("create_entry", { entry: { bookingDate: "2026-07-21", text: "nur ein Vorschlag", lines: [{ accountNumber: "1800", amountCents: 100 }, { accountNumber: "2900", amountCents: -100 }] }, book: false }, tenantId);

    const result = await call("create_datev_export", { from: "2026-07-01", to: "2026-07-31", description: "Juli 2026" }, tenantId);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ fileName: "EXTF_Buchungsstapel_20260701_20260731.csv", encoding: "windows-1252", rowCount: 3, entryCount: 2, warnings: [] });

    const bytes = Buffer.from(result.data!.contentBase64 as string, "base64");
    expect(bytes.includes(0xfc)).toBe(true); // ü of "für" in Windows-1252
    const lines = new TextDecoder("windows-1252").decode(bytes).split("\r\n");
    expect(lines[0]).toContain(";1001;10001;20260101;4;20260701;20260731;");
    expect(lines.slice(2, 5).map((line) => line.split(";").slice(0, 9).join(";"))).toEqual([
      '11,90;"S";"EUR";;;;6810;3300;"9"',
      '80,00;"S";"EUR";;;;1200;4300;',
      '30,00;"S";"EUR";;;;1200;4400;',
    ]);
  });
});
