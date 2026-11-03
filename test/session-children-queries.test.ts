import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import type { Principal, Session } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

async function childrenQueries(children: number, busyTrees: number): Promise<number> {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "children-")), seedSkills: false }));
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const principal: Principal = { id: "internal:U1", type: "internal" };
  const session = async (threadRef: string, parent?: Session) => {
    const s = await built.sessions.getOrCreateByThread(threadRef, "dm", "personal:U1", undefined, "web");
    await built.sessions.addParticipant(s.id, "U1", threadRef);
    if (parent) await built.sessions.setParentSession(s.id, parent.id);
    return s;
  };
  const busy = (s: Session) =>
    built.runs.enqueue({
      sessionId: s.threadRef,
      request: {
        actor: principal,
        conversation: { kind: "dm", threadRef: s.threadRef, audience: [principal] },
        origin: { kind: "direct" },
        text: "working",
      },
    });
  try {
    const root = await session("web:U1:root");
    let parent = root;
    for (let i = 0; i < children; i++) {
      const child = await session(`subagent:root:${i}`, i % 2 ? parent : root);
      if (i % 5 === 0) await busy(child);
      parent = child;
    }
    for (let t = 0; t < busyTrees; t++) {
      let leaf = await session(`web:U1:other${t}`);
      for (let d = 0; d < 3; d++) leaf = await session(`subagent:other${t}:${d}`, leaf);
      await busy(leaf);
    }
    const url = `${base}/v1/sessions/${root.id}/children?principalId=U1`;
    await fetch(url);
    let count = 0;
    const query = pg.Client.prototype.query;
    pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<typeof query>) {
      count++;
      return query.apply(this, args);
    } as typeof query;
    try {
      const res = await fetch(url);
      const body = (await res.json()) as { sessions: Session[] };
      assert.equal(body.sessions.length, children);
    } finally {
      pg.Client.prototype.query = query;
    }
    return count;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
}

test("listing a root's children costs the same number of queries for 3 children or 50, however busy the org is", async () => {
  const small = await childrenQueries(3, 0);
  const large = await childrenQueries(50, 0);
  const busy = await childrenQueries(3, 20);
  assert.equal(large, small);
  assert.equal(busy, small);
});

test("a session's same-scope ancestors come back nearest first, skipping ancestors in another scope", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ancestors-")), seedSkills: false }));
  try {
    const session = async (threadRef: string, scope: string, parent?: Session) => {
      const s = await built.sessions.getOrCreateByThread(threadRef, "dm", scope, undefined, "web");
      if (parent) await built.sessions.setParentSession(s.id, parent.id);
      return s;
    };
    const root = await session("web:U1:root", "personal:U1");
    const elsewhere = await session("subagent:root:1", "channel:C1", root);
    const mid = await session("subagent:root:2", "personal:U1", elsewhere);
    const leaf = await session("subagent:root:3", "personal:U1", mid);
    const ancestors = await built.sessions.sameScopeAncestors([leaf.threadRef, "web:U1:missing"]);
    assert.deepEqual(
      ancestors.map((a) => a.threadRef),
      [mid.threadRef, root.threadRef],
      "nearest ancestor first",
    );
    assert.deepEqual(await built.sessions.sameScopeAncestors([root.threadRef]), []);
  } finally {
    await built.runtime.stop();
  }
});
