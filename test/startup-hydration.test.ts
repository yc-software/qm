import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as identityModule from "../src/identity/identity-service.ts";
import * as configModule from "../src/resolution/config-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { testConfig } from "./support/test-config.ts";

const identityFailure = new Error("identity persistence unavailable");
const configFailure = new Error("configuration persistence unavailable");

mock.module("../src/identity/identity-service.ts", {
  namedExports: {
    ...identityModule,
    createIdentityService: (...args: Parameters<typeof identityModule.createIdentityService>) =>
      identityModule.createIdentityService(
        {
          ...createMemoryMap<identityModule.DeactivationRecord>(),
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
    createMemoryConfigStore: (...args: Parameters<typeof configModule.createMemoryConfigStore>) =>
      configModule.createMemoryConfigStore(args[0], {
        ...args[1],
        deploymentIdentity: {
          ...args[1]!.deploymentIdentity!,
          putIfAbsent: async () => {
            throw configFailure;
          },
        },
      }),
  },
});

const { buildApp } = await import("../src/wiring.ts");

test("eager hydration failures are contained while explicit startup hydration remains fail-closed", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const built = buildApp(testConfig());
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(errors.mock.calls.some(({ arguments: args }) => String(args[0]).includes("startup: hydrate identity")));
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
