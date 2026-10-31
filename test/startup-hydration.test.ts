import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as identityModule from "../src/identity/identity-service.ts";
import * as configModule from "../src/resolution/config-store.ts";
import { testConfig } from "./support/test-config.ts";
import { bindTestTenant } from "./support/tenant.ts";
import { createMemoryConfigTables } from "../src/resolution/config-tables.ts";

bindTestTenant();

const identityFailure = new Error("identity persistence unavailable");
const configFailure = new Error("configuration persistence unavailable");

mock.module("../src/identity/identity-service.ts", {
  namedExports: {
    ...identityModule,
    createIdentityService: (...args: Parameters<typeof identityModule.createIdentityService>) =>
      identityModule.createIdentityService({
        ...args[0],
        deactivations: {
          ...identityModule.createDeactivationStore(),
          list: async () => {
            throw identityFailure;
          },
        },
      }),
  },
});
mock.module("../src/resolution/config-store.ts", {
  namedExports: {
    ...configModule,
    createMemoryConfigStore: (...args: Parameters<typeof configModule.createMemoryConfigStore>) =>
      configModule.createMemoryConfigStore({
        ...args[0],
        tables: {
          ...createMemoryConfigTables(),
          scopeSettings: async () => {
            throw configFailure;
          },
        },
      }),
  },
});

const { buildApp } = await import("./support/build-app.ts");

test("eager hydration failures are contained while explicit startup hydration remains fail-closed", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const built = buildApp(testConfig());
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(
      errors.mock.calls.some(({ arguments: args }) => String(args[0]).includes("startup: hydrate configuration")),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(built.identity.hydrate(), (error: unknown) => error === identityFailure);
      await assert.rejects(built.config.hydrate!(), (error: unknown) => error === configFailure);
    }
  } finally {
    await built.runtime.stop();
  }
});
