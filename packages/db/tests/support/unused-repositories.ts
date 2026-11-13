import type { Repositories } from "../../src";

/**
 * Completes a partial `Repositories` bundle for unit tests: every slot the test does not provide
 * throws on first use, so a use case that unexpectedly reaches into another repository fails
 * loudly instead of silently reading `undefined`.
 */
export function withUnusedRepositories(provided: Partial<Repositories>): Repositories {
  return new Proxy(provided as Repositories, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      // Symbols (inspection) and `then` (thenable checks by `await`) must not throw.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      throw new Error(`Repositories.${String(prop)} is not provided by this test's fake`);
    },
  });
}
