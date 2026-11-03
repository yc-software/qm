import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as identityModule from "../src/identity/identity-service.ts";
import * as configModule from "../src/resolution/config-store.ts";
import { testConfig } from "./support/test-config.ts";
import { testMap } from "./support/test-database.ts";
import { inTestTenant } from "./support/test-tenants.ts";

const identityFailure = new Error("identity persistence unavailable");
const configFailure = new Error("configuration persistence unavailable");

mock.module("../src/identity/identity-service.ts", {
  namedExports: {
    ...identityModule,
    createIdentityService: (...args: Parameters<typeof identityModule.createIdentityService>) =>
      identityModule.createIdentityService(
        {
          ...testMap<identityModule.DeactivationRecord>(),
          all: async () => {
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
      configModule.createConfigStore(args[0], {
        ...args[1],
        deploymentIdentity: {
          ...args[1].deploymentIdentity,
          putIfAbsent: async () => {
            throw configFailure;
          },
        },
      }),
  },
});

const { buildApp } = await import("../src/wiring.ts");

test("a failed first-bind load fails closed and runs again on the next use", async () => {
  const built = buildApp(testConfig());
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        inTestTenant(() => undefined),
        (error: unknown) => error === identityFailure || error === configFailure,
      );
    }
  } finally {
    await built.runtime.stop();
  }
});
