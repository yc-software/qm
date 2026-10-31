import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as identityModule from "../src/identity/identity-service.ts";
import * as configModule from "../src/resolution/config-store.ts";
import { testConfig } from "./support/test-config.ts";
import { testMap } from "./support/test-database.ts";

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

const { buildApp } = await import("./support/build-app.ts");

test("construction touches no storage while boot and explicit hydration remain fail-closed", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const built = buildApp(testConfig());
  try {
    assert.equal(errors.mock.callCount(), 0);
    await assert.rejects(built.boot());
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(built.identity.refresh(), (error: unknown) => error === identityFailure);
      await assert.rejects(built.config.hydrate!(), (error: unknown) => error === configFailure);
    }
  } finally {
    await built.runtime.stop();
  }
});
