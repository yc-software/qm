import { test } from "node:test";
import assert from "node:assert/strict";
import { recordConnectorLink, replyConnectorLinks } from "../src/connectors/connector-links.ts";
import { createMemoryRunActivityStore } from "../src/runs/run-activity-store.ts";

const GOOGLE = { provider: "google", url: "https://qm.example/connect/redeem/a?p=google" };
const GMAIL = { provider: "composio", url: "https://connect.composio.dev/link/lk_a", toolkit: "gmail" };

test("each reply carries the run's links not already sent with an earlier reply", async () => {
  const store = createMemoryRunActivityStore();
  const next = replyConnectorLinks(store, "run-1");
  await recordConnectorLink(store, "run-1", GOOGLE);
  await store.append("run-1", { seq: 3, parentSeq: null, type: "tool_result", payload: GMAIL, createdAt: Date.now() });
  await recordConnectorLink(store, "run-1", GOOGLE);
  await recordConnectorLink(store, "run-2", GMAIL);
  assert.deepEqual(await next(), [GOOGLE]);
  await recordConnectorLink(store, "run-1", GMAIL);
  assert.deepEqual(await next(), [GMAIL]);
  assert.deepEqual(await next(), []);
});

test("a link minted outside a run is not recorded, and a failing store does not fail the mint or the reply", async () => {
  const store = createMemoryRunActivityStore();
  await recordConnectorLink(store, undefined, GOOGLE);
  await recordConnectorLink(undefined, "run-1", GOOGLE);
  assert.deepEqual(await replyConnectorLinks(store, "run-1")(), []);
  const broken = {
    append: async () => {
      throw new Error("down");
    },
    list: async () => {
      throw new Error("down");
    },
  };
  await recordConnectorLink(broken, "run-1", GOOGLE);
  assert.deepEqual(await replyConnectorLinks(broken, "run-1")(), []);
});
