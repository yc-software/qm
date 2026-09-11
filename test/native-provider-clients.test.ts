import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createSdkModalClient } from "../src/sandbox/modal-client.ts";
import { createSdkE2bClient } from "../src/sandbox/e2b-client.ts";

const modalCalls: unknown[][] = [];
const modalSandbox = {
  sandboxId: "sb-native",
  async snapshotDirectory(path: string, options: unknown) {
    modalCalls.push(["snapshot", path, options]);
    return { imageId: "im-native" };
  },
  async mountImage(path: string, image: unknown) {
    modalCalls.push(["mount", path, image]);
  },
};
mock.module("modal", {
  namedExports: {
    ModalClient: class {
      apps = { fromName: async () => ({}) };
      images = { fromRegistry: () => ({}), fromId: async (imageId: string) => ({ imageId }) };
      sandboxes = { create: async () => modalSandbox };
    },
  },
});

const e2bCalls: unknown[][] = [];
let pauseError: Error | undefined;
mock.module("e2b", {
  namedExports: {
    Sandbox: class {
      static async create(template: string, options: unknown) {
        e2bCalls.push(["create", template, options]);
        return {
          sandboxId: "e2b-native",
          async pause(options: unknown) {
            e2bCalls.push(["pause", options]);
            if (pauseError) throw pauseError;
            return false;
          },
        };
      }
      static async getInfo() {
        e2bCalls.push(["info"]);
        return { state: "paused", endAt: new Date(1000), lifecycle: { onTimeout: "pause" } };
      }
    },
  },
});

test("Modal native directory snapshot uses explicit finite retention and restores the exact image", async () => {
  const client = createSdkModalClient({
    tokenId: "id",
    tokenSecret: "secret",
    appName: "test",
    image: "ubuntu",
    snapshotRetentionMs: 60_000,
  });
  const session = await client.create({ name: "test" });
  const before = Date.now();
  const snapshot = await session.snapshotHome!();
  assert.deepEqual(modalCalls[0], ["snapshot", "/root", { ttlMs: 60_000 }]);
  assert.ok(snapshot.expiresAtMs >= before + 60_000);
  await session.restoreHome!(snapshot.imageId);
  assert.deepEqual(modalCalls[1], ["mount", "/root", { imageId: "im-native" }]);
  assert.equal(client.lifetimeMs, 24 * 3600_000);
});

test("Modal rejects invalid checkpoint retention", () => {
  for (const snapshotRetentionMs of [0, -1, Infinity, NaN]) {
    assert.throws(
      () =>
        createSdkModalClient({
          tokenId: "id",
          tokenSecret: "secret",
          appName: "test",
          image: "ubuntu",
          snapshotRetentionMs,
        }),
      /positive finite/,
    );
  }
});

test("E2B sends explicit pause lifecycle, reads state without connect, and surfaces failed pause", async () => {
  const client = createSdkE2bClient({ apiKey: "test" });
  const session = await client.create({ metadata: { name: "test" }, autoPause: true });
  assert.deepEqual((e2bCalls[0]![2] as { lifecycle: unknown }).lifecycle, { onTimeout: "pause", autoResume: false });
  assert.equal(await client.info!(session.sandboxId).then((info) => info.state), "paused");
  await session.pause();
  assert.deepEqual(e2bCalls.at(-1), ["pause", { keepMemory: true }]);
  pauseError = new Error("snapshot backlog");
  await assert.rejects(session.pause(), /snapshot backlog/);
  pauseError = undefined;
  await client.create({ metadata: {}, autoPause: false });
  assert.deepEqual((e2bCalls.at(-1)![2] as { lifecycle: unknown }).lifecycle, { onTimeout: "kill", autoResume: false });
});
