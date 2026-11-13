// The `UnitOfWork`: a thin wrapper around Drizzle's own `db.transaction`, handing the
// transaction-bound repositories to `work` instead of the raw `tx` handle (use cases never see a
// `tx`/`DbExecutor`).
import type { LedgerDb } from "../../foundation/client";
import type { UnitOfWork } from "../contracts";
import { createDrizzleRepositories } from "./create-repositories";

export function createDrizzleUnitOfWork(db: LedgerDb): UnitOfWork {
  return {
    transaction: (work) => db.transaction((tx) => work(createDrizzleRepositories(tx))),
  };
}
