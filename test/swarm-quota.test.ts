import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { App } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

test("live HTTP self-lowering descendant cap constrains grandchildren atomically", async () => {
  const f = await swarmFixture();
  const [parent] = await f.service.spawn(f.caller, { requestId: "parent", text: "Work" });
  await f.service.sweep();
  const caller = await f.workerCaller(parent!.id);
  assert.equal(caller.kind, "agent");
  if (caller.kind !== "agent") throw new Error("agent required");
  const secret = "descendant-cap-fixture-capability-secret";
  const server = createServer({ swarms: f.service, authorizesCapabilityScope: async () => true } as unknown as App, {
    signingSecret: secret,
    capabilitySecret: secret,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/swarm`;
    const token = await mintCapabilityToken(caller.claims, secret);
    const headers = { "x-agent-capability": token, "content-type": "application/json" };
    const lowered = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "limit", descendants: 1 }),
    });
    assert.equal(lowered.status, 200, await lowered.clone().text());
    const [child] = await f.service.spawn(caller, { requestId: "child", text: "Work" });
    await f.service.sweep();
    const childCaller = await f.workerCaller(child!.id);
    await assert.rejects(f.service.spawn(childCaller, { requestId: "grandchild", text: "Work" }), /descendant budget/);
    const raised = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "limit", descendants: 2 }),
    });
    assert.equal(raised.status, 400);
    const forged = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "limit", descendants: 0, memberId: f.root.id }),
    });
    assert.equal(forged.status, 400);
    assert.equal((await f.store.get(f.root.id))!.members.length, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("subtree cap races count reserved, failed, stopped and deleted members; lowering never evicts them", async () => {
  const f = await swarmFixture();
  await f.service.character(f.caller, { version: 0, name: "Root", character: {} });
  await f.service.limit(f.caller, 1);
  const attempts = await Promise.allSettled(
    ["a", "b"].map((requestId) => f.service.spawn(f.caller, { requestId, text: "Work" })),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  await f.service.sweep();
  const member = (await f.service.inspect(f.caller)).peers.find((m) => m.parentId)!;
  await f.sessions.deleteSession(member.sessionId!);
  await f.store.update(f.root.id, (swarm) => {
    swarm.members.find((m) => m.id === member.id)!.state = "failed";
  });
  const human = { kind: "human" as const, actorId: "alice", sessionId: f.root.id };
  await f.service.control(human, { memberId: member.id, command: "stop" });
  await assert.rejects(f.service.spawn(f.caller, { requestId: "after-delete", text: "Work" }), /descendant budget/);
  await f.service.limit(f.caller, 0);
  assert.equal((await f.store.get(f.root.id))!.members.length, 2);
  await assert.rejects(f.service.limit(f.caller, 1), /only be lowered/);
  for (const invalid of [-1, 0.5, NaN, Infinity, "0"])
    await assert.rejects(f.service.limit(f.caller, invalid as number), /invalid descendant/);
  f.state.manageable = false;
  await assert.rejects(f.service.limit(human, 0), /scope management/);
  f.state.manageable = true;
  await f.service.control(human, { memberId: f.root.id, command: "pause" });
  await assert.rejects(f.service.limit(f.caller, 0), /paused/);
});
