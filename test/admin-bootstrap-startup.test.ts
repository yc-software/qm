import assert from "node:assert/strict";
import { mock, test } from "node:test";

let serverCreated = 0;

mock.module("../src/config.ts", {
  namedExports: {
    loadConfig: () => ({}),
  },
});

mock.module("../src/wiring.ts", {
  namedExports: {
    buildApp: () => ({
      admin: {
        ready: async () => {
          throw new Error("admin bootstrap unavailable");
        },
      },
    }),
    serverDeps: () => ({}),
    stopWithBackstop: () => undefined,
  },
});

mock.module("../src/api/server.ts", {
  namedExports: {
    createServer: () => {
      serverCreated++;
      return {};
    },
  },
});

test("admin bootstrap failure prevents the health server from being created", async () => {
  await assert.rejects(import("../src/index.ts"), /admin bootstrap unavailable/);
  assert.equal(serverCreated, 0);
});
