import assert from "node:assert/strict";
import { test } from "node:test";

import { needsRefresh, statuses, summary, type SwarmPeer, type SwarmView } from "../src/swarm-status.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");

function swarm(workers: Array<Partial<SwarmPeer>>, expiresAt?: number): SwarmView {
  const root: SwarmPeer = { id: "root", state: "ready", depth: 0 };
  const peers = [
    root,
    ...workers.map((worker, index) => ({
      id: `w${index}`,
      parentId: "root",
      state: "ready" as const,
      depth: 1,
      ...worker,
    })),
  ];
  return { id: "root", self: root, peers, ...(expiresAt === undefined ? {} : { expiresAt }) };
}

const label = (view: SwarmView) => summary(view, statuses(view, NOW));

test("running workers are counted separately from idle ones, and an idle swarm is not active", () => {
  assert.equal(label(swarm(Array.from({ length: 8 }, () => ({})))), "8 idle");
  assert.equal(label(swarm([{ running: true }, { running: true }, {}, {}, {}, {}, {}, {}])), "2 running · 6 idle");
  assert.equal(label(swarm([{ running: true }, {}], NOW + 60_000)), "1 running · 1 idle");
});

test("an expired swarm shows its workers as expired and keeps refreshing so the root can extend it", () => {
  const view = swarm([{ running: true }, {}, { control: "paused" }, { control: "stopped" }], NOW - 1);
  assert.equal(label(view), "1 stopped · 3 expired");
  assert.equal(needsRefresh(view, statuses(view, NOW)), true);
});

test("other states keep their own counts, ancestors' controls apply, and finished swarms stop refreshing", () => {
  const view = swarm([{ state: "reserved" }, { control: "paused" }, { control: "stopped" }, { state: "failed" }, {}]);
  view.peers.push({ id: "child", parentId: "w1", state: "ready", depth: 2, running: true });
  assert.equal(label(view), "1 idle · 1 starting · 2 paused · 1 stopped · 1 failed");
  const done = swarm([{ control: "stopped" }, { state: "failed" }, { control: "paused" }]);
  assert.equal(needsRefresh(done, statuses(done, NOW)), false);
});
