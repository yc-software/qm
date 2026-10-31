import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as identityModule from "../src/identity/identity-service.ts";
import * as configModule from "../src/resolution/config-store.ts";
import { testConfig } from "./support/test-config.ts";
import { testMap } from "./support/test-database.ts";

const identityFailure = new Error("identity persistence unavailable");
const configFailure = new Error("configuration persistence unavailable");
const reads = { identity: 0, config: 0 };

mock.module("../src/identity/identity-service.ts", {
  namedExports: {
    ...identityModule,
    createIdentityService: (...args: Parameters<typeof identityModule.createIdentityService>) =>
      identityModule.createIdentityService(
        {
          ...testMap<identityModule.DeactivationRecord>(),
          all: async () => {
            reads.identity++;
            throw identityFailure;
          },
        },
        args[1],
      ),
  },
});
mock.module("../src/resolution/config-store.ts", {
  namedExports: {
    ...configModule,
    createConfigStore: (...args: Parameters<typeof configModule.createConfigStore>) =>
      configModule.createConfigStore({
        ...args[0],
        souls: {
          ...args[0].souls,
          all: async () => {
            reads.config++;
            throw configFailure;
          },
        },
      }),
  },
});

const { buildApp } = await import("./support/build-app.ts");

test("building the app reads no identity or configuration until startup hydrates them, and hydration fails closed", async () => {
  const built = buildApp(testConfig());
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reads, { identity: 0, config: 0 });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(built.identity.refresh(), (error: unknown) => error === identityFailure);
      await assert.rejects(built.config.hydrate!(), (error: unknown) => error === configFailure);
    }
  } finally {
    await built.runtime.stop();
  }
});
