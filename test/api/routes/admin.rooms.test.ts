import { createAdminCall } from "../../../src/tools/admin.ts";
import { createAgentTools } from "../../../src/harness/agent-tools.ts";
import { createTurnToolState } from "../../../src/harness/turn-tool-state.ts";
import type { ToolContext } from "../../../src/tools/primitives.ts";
import "../../support/auto-fake-sprites.ts";
import { selectDefaultSandbox } from "../../support/default-sandbox.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId, type TurnRequest } from "../../../src/types.ts";
import { ORG, start, capFor } from "../../support/admin-capability.ts";

for (const liveAuthor of [false, true]) {
  test(`thread author admin access (${liveAuthor}) preserves all other authorization gates`, async () => {
    const s = await start();
    try {
      const cap = await capFor("admin-alice", { live: false, liveAuthor, scope: "channel:C1" });
      const headers = { "x-agent-capability": cap, "content-type": "application/json" };
      const path = `/v1/admin/scopes/${ORG}/approval-grant-modes`;
      const write = await fetch(`${s.base}${path}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ session: true, always: false }),
      });
      assert.equal(write.status, liveAuthor ? 200 : 403);
      if (!liveAuthor) return;
      const read = await fetch(`${s.base}/v1/admin/scopes/${ORG}`, { headers });
      assert.equal(read.status, 200);
      assert.deepEqual(((await read.json()) as { approvalGrantModes: unknown }).approvalGrantModes, {
        session: true,
        always: false,
      });
      for (const restricted of ["/v1/admin/sessions", "/v1/admin/keychain"]) {
        assert.notEqual(
          (await fetch(`${s.base}${restricted}`, { headers })).status,
          403,
          "a live thread author's private reads are not refused",
        );
      }
      assert.equal(
        (
          await fetch(`${s.base}/v1/admin/grants`, {
            method: "POST",
            headers,
            body: JSON.stringify({ principalId: "U9", role: "org_admin", scopeId: ORG }),
          })
        ).status,
        403,
      );
      const memberCap = await capFor("U1", { live: false, liveAuthor: true });
      assert.equal(
        (
          await fetch(`${s.base}${path}`, {
            method: "PUT",
            headers: { ...headers, "x-agent-capability": memberCap },
            body: JSON.stringify({ session: true, always: false }),
          })
        ).status,
        403,
      );
      await s.built.admin.revokeGrant({ id: "admin-bob", type: "internal" }, "admin-alice", ORG, "org_admin");
      assert.equal(
        (
          await fetch(`${s.base}${path}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ session: true, always: false }),
          })
        ).status,
        403,
      );
    } finally {
      await s.close();
    }
  });
}

for (const [name, input, expected] of [
  ["human thread reply", { origin: { kind: "ambient", live: true } }, 200],
  ["synthetic ambient wake", { origin: { kind: "ambient" } }, 403],
  ["bot thread reply", { botActor: true, origin: { kind: "ambient" } }, 403],
  ["cron", { surface: "cron", origin: { kind: "automation" } }, 403],
  ["webhook", { surface: "webhook", origin: { kind: "automation" } }, 403],
] satisfies Array<[string, Partial<TurnRequest>, number]>) {
  test(`orchestrator-issued ${name} token reaches the HTTP admin gate with the right authority`, async () => {
    const s = await start();
    try {
      await selectDefaultSandbox(s.built, "admin-alice", "channel:C1");
      let cap: string | undefined;
      const provision = s.built.sandbox.provision.bind(s.built.sandbox);
      s.built.sandbox.provision = (layers, opts) => {
        cap = opts?.env?.AGENT_API_TOKEN;
        return provision(layers, opts);
      };
      const admin = { externalId: "admin-alice" };
      const result = await s.built.app.turn({
        surface: "test",
        actor: admin,
        conversation: {
          kind: "channel",
          threadRef: "ch:C1:reply",
          channelRef: "C1",
          audience: [admin],
          publishMembers: [admin],
        },
        text: "!run echo ok",
        ...input,
      });
      assert.equal(result.status, "ok");
      assert.ok(cap);
      const res = await fetch(`${s.base}/v1/admin/scopes/${ORG}/approval-grant-modes`, {
        method: "PUT",
        headers: { "x-agent-capability": cap, "content-type": "application/json" },
        body: JSON.stringify({ session: true, always: true }),
      });
      assert.equal(res.status, expected);
    } finally {
      await s.close();
    }
  });
}

for (const room of [scopeId("channel", "C1"), scopeId("group", "G1")]) {
  test(`from ${room}, admin private reads and writes need a turn a live admin started, are audited, and stop when the admin role is revoked`, async () => {
    const s = await start();
    try {
      await s.built.directory.replaceGroups([
        { groupId: "G1", principalId: "admin-alice" },
        { groupId: "G1", principalId: "U1" },
      ]);
      const cap = await capFor("admin-alice", { scope: room });
      const headers = { "x-agent-capability": cap, "content-type": "application/json" };
      const target = scopeId("personal", "U1");
      await s.built.memory.capture(target, ["private test sentinel"], Date.now());
      const path = `/v1/admin/memory?scope=${encodeURIComponent(target)}`;
      const read = () => fetch(`${s.base}${path}`, { headers });
      const response = await read();
      assert.equal(response.status, 200);
      assert.match(((await response.json()) as { content: string }).content, /private test sentinel/);
      const reads = (await s.built.auditLog.events()).filter((e) => e.action === "memory.read");
      assert.equal(reads.length, 1);
      assert.equal(reads[0]!.principalId, "admin-alice");
      assert.equal(reads[0]!.scopeLabel, target);
      for (const route of [`/v1/admin/sessions?scope=${target}`, "/v1/admin/keychain", `/v1/admin/scopes/${target}`]) {
        assert.equal((await fetch(`${s.base}${route}`, { headers })).status, 200, route);
      }
      const write = (token = cap) =>
        fetch(`${s.base}/v1/admin/scopes/${target}/instructions`, {
          method: "PUT",
          headers: { ...headers, "x-agent-capability": token },
          body: JSON.stringify({ content: "Open admin configuration sentinel" }),
        });
      assert.equal((await write()).status, 200);
      assert.equal(await s.built.config.getInstructions(target), "Open admin configuration sentinel");
      const writes = (await s.built.auditLog.events()).filter((e) => e.action === "instructions.update");
      assert.equal(writes.length, 1);
      assert.equal(writes[0]!.principalId, "admin-alice");
      assert.equal(writes[0]!.scopeLabel, target);
      for (const liveAuthor of [false, true]) {
        const token = await capFor("admin-alice", { scope: room, live: false, liveAuthor });
        assert.equal(
          (await fetch(`${s.base}${path}`, { headers: { "x-agent-capability": token } })).status,
          liveAuthor ? 200 : 403,
          "a room token reads private memory only when a live admin started the turn",
        );
        assert.equal((await write(token)).status, liveAuthor ? 200 : 403);
      }
      const unattended = await capFor("admin-alice", {
        scope: room,
        live: false,
        grants: ["admin.sessions.read"],
      });
      assert.equal(
        (
          await fetch(`${s.base}/v1/admin/sessions`, {
            headers: { "x-agent-capability": unattended },
          })
        ).status,
        403,
        "an unattended admin.sessions.read grant does not open admin sessions from a room",
      );
      for (const [method, route] of [
        ["POST", "/v1/admin/grants"],
        ["DELETE", `/v1/admin/grants/admin-bob?scope=${ORG}&role=org_admin`],
        ["POST", "/v1/admin/impersonate"],
      ]) {
        assert.equal(
          (
            await fetch(`${s.base}${route}`, {
              method,
              headers,
              body: "{}",
            })
          ).status,
          403,
          `${route} retains its existing restriction`,
        );
      }
      const nonAdmin = await capFor("U1", { scope: room });
      assert.equal(
        (
          await fetch(`${s.base}${path}`, {
            headers: { "x-agent-capability": nonAdmin, "x-admin-actor": "admin-alice@default-org" },
          })
        ).status,
        403,
        "a non-admin token with a spoofed x-admin-actor header is refused",
      );
      assert.equal((await write(nonAdmin)).status, 403, "a non-admin room member cannot write admin instructions");
      await s.built.admin.revokeGrant({ id: "admin-bob", type: "internal" }, "admin-alice", ORG, "org_admin");
      assert.equal((await read()).status, 403, "revoking the admin role stops reads on an already-issued room token");
      assert.equal((await write()).status, 403, "revoking the admin role stops writes on an already-issued room token");
    } finally {
      await s.close();
    }
  });
}

for (const room of [scopeId("personal", "admin-alice"), scopeId("channel", "C1"), scopeId("group", "G1")]) {
  test(`retired bulk import is equally unsupported from ${room}`, async () => {
    const s = await start();
    try {
      await s.built.directory.replaceGroups([
        { groupId: "G1", principalId: "admin-alice" },
        { groupId: "G1", principalId: "U1" },
      ]);
      const cap = await capFor("admin-alice", { scope: room });
      const response = await fetch(`${s.base}/v1/admin/scopes/${ORG}/import`, {
        method: "PUT",
        headers: { "x-agent-capability": cap, "content-type": "application/json" },
        body: JSON.stringify({ soul: "must not be imported" }),
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not_found", message: "unknown admin resource: import" });
      assert.notEqual(await s.built.config.getInstructions(ORG), "must not be imported");
    } finally {
      await s.close();
    }
  });
}

test("shared-channel admin runtime mutations do not return a private cron prompt", async () => {
  const s = await start();
  try {
    const cron = await s.built.app.createCron({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      action: "private task details",
    });
    const cap = await capFor("admin-alice", { scope: "channel:C1" });
    const headers = { "x-agent-capability": cap, "content-type": "application/json" };
    const read = await fetch(`${s.base}/v1/admin/crons?scope=personal:U1`, { headers });
    assert.equal(read.status, 200);
    const updated = await fetch(`${s.base}/v1/admin/crons/${cron.id}/runtime?scope=personal:U1`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ runtime: null }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), { cron: { id: cron.id, runtime: null } });
    const retargeted = await fetch(`${s.base}/v1/admin/crons/${cron.id}/destination?scope=personal:U1`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ destination: null }),
    });
    assert.equal(retargeted.status, 200);
    assert.deepEqual(await retargeted.json(), { cron: { id: cron.id } });
    const unattended = await capFor("admin-alice", { live: false, scope: "channel:C1" });
    const denied = await fetch(`${s.base}/v1/admin/crons/${cron.id}/runtime?scope=personal:U1`, {
      method: "PUT",
      headers: { ...headers, "x-agent-capability": unattended },
      body: JSON.stringify({ runtime: null }),
    });
    assert.equal(denied.status, 403);
  } finally {
    await s.close();
  }
});

test("native admin tools use the authenticated handler, including its live authority, audience and audit checks", async () => {
  const s = await start();
  const target = scopeId("personal", "U1");
  try {
    const call = createAdminCall(s.base, await capFor("admin-alice"));
    const tool = createAgentTools(
      createTurnToolState({ current: { admin: { call, operationsAvailable: true } } as ToolContext }),
      { controlTools: true },
    ).find((t) => t.name === "admin")!;
    await s.built.memory.capture(target, ["draft fixture"], Date.UTC(2026, 0, 2));
    const [seeded] = (await s.built.memory.facts!(target))!;
    const written = await tool.execute(
      "native-write",
      {
        action: "edit_memory",
        scope: target,
        value: { facts: [{ id: seeded!.id, text: "synthetic admin tool fixture" }] },
      },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(JSON.parse((written.content[0] as { text: string }).text).status, 200);
    const read = await tool.execute(
      "native-read",
      { action: "memory", scope: target },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(
      JSON.parse((read.content[0] as { text: string }).text).body.content,
      "- (2026-01-02) synthetic admin tool fixture",
    );
    assert.equal(
      (await s.built.auditLog.events()).filter((e) => e.action === "memory.update" && e.principalId === "admin-alice")
        .length,
      1,
    );
    for (const claims of [await capFor("U1"), await capFor("admin-alice", { live: false })]) {
      const denied = await createAdminCall(s.base, claims)({ action: "memory", scope: target });
      assert.equal(denied.status, 403);
      assert.doesNotMatch(JSON.stringify(denied.body), /synthetic admin tool fixture/);
    }
    const shared = createAdminCall(s.base, await capFor("admin-alice", { scope: "channel:C1" }));
    assert.equal((await shared({ action: "scopes" })).status, 200);
    assert.equal((await call({ action: "scopes" })).status, 200);
    await s.built.admin.revokeGrant({ id: "admin-bob", type: "internal" }, "admin-alice", ORG, "org_admin");
    assert.equal((await call({ action: "memory", scope: target })).status, 403);
  } finally {
    await s.close();
  }
});
