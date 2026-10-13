import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "memory-http-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    memory: built.memory,
    workspace: built.workspace,
    sessions: built.sessions,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE_ADMIN = { "x-admin-actor": "admin-alice@default-org" };
const json = async (r: Response): Promise<any> => r.json();

const send = (base: string, path: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("a user edits and forgets facts in their OWN personal notebook only", async () => {
  const s = start();
  try {
    const mine = scopeId("personal", "U1");
    await s.built.memory.capture(mine, ["Prefers terse replies", "Works in ET"], Date.parse("2026-05-31"));
    const [terse, tz] = (await json(await fetch(`${s.base}/v1/memory?principalId=U1`))).facts;
    assert.equal(terse.text, "Prefers terse replies");

    const edited = await send(s.base, "/v1/memory", "PATCH", {
      principalId: "U1",
      facts: [{ id: tz.id, text: "Works in PT" }],
    });
    assert.equal(edited.status, 200);
    assert.equal(await s.built.memory.read(mine), "- (2026-05-31) Prefers terse replies\n- (2026-05-31) Works in PT");
    assert.equal((await send(s.base, "/v1/memory", "DELETE", { principalId: "U1", ids: [terse.id] })).status, 200);
    assert.equal(await s.built.memory.read(mine), "- (2026-05-31) Works in PT");

    assert.equal(
      (await send(s.base, "/v1/memory", "PATCH", { principalId: "U2", facts: [{ id: tz.id, text: "hijack" }] })).status,
      404,
      "ids are per notebook, so another user's ids are missing in yours",
    );
    assert.equal((await send(s.base, "/v1/memory", "PATCH", { principalId: "U1", facts: [] })).status, 400);
    assert.equal((await fetch(`${s.base}/v1/memory`)).status, 400, "GET needs principalId");

    const actions = (await s.built.auditLog.events()).filter((e) => e.principalId === "U1").map((e) => e.action);
    assert.ok(actions.includes("memory.self.read") && actions.includes("memory.self.update"));
  } finally {
    await s.close();
  }
});

test("an admin edits any scope's facts by id; non-admins are refused without a write", async () => {
  const s = start();
  try {
    const scope = "channel:C9";
    const path = `/v1/admin/memory?scope=${encodeURIComponent(scope)}`;
    await s.built.memory.capture(scope, ["The standup is at 10am"], Date.parse("2026-05-31"));
    const [fact] = (await json(await fetch(`${s.base}${path}`, { headers: ALICE_ADMIN }))).facts;

    const nobody = { "x-admin-actor": "nobody@default-org" };
    assert.equal((await fetch(`${s.base}${path}`, { headers: nobody })).status, 403);
    assert.equal((await send(s.base, path, "PATCH", { facts: [{ id: fact.id, text: "evil" }] }, nobody)).status, 403);
    assert.equal((await fetch(`${s.base}/v1/admin/memory`, { headers: ALICE_ADMIN })).status, 400);

    const edited = await send(
      s.base,
      path,
      "PATCH",
      { facts: [{ id: fact.id, text: "Standup moved to 9:30" }] },
      ALICE_ADMIN,
    );
    assert.equal((await json(edited)).content, "- (2026-05-31) Standup moved to 9:30");
    assert.equal((await json(await send(s.base, path, "DELETE", { ids: [fact.id] }, ALICE_ADMIN))).content, "");

    const actions = (await s.built.auditLog.events()).map((e) => e.action);
    assert.ok(actions.includes("memory.read") && actions.includes("memory.update"), "admin memory access is audited");
  } finally {
    await s.close();
  }
});

test("the admin memory directory lists every known scope, notebooks-first (powers the picker)", async () => {
  const s = start();
  try {
    const session = await s.built.sessions.getOrCreateByThread("T1", "channel", "channel:C9", "eng");
    await s.built.sessions.addParticipant(session.id, "U1");
    await s.built.memory.capture("channel:C9", ["The standup is at 10am"], Date.parse("2026-05-31"));

    const r = await fetch(`${s.base}/v1/admin/memory/scopes`, { headers: ALICE_ADMIN });
    assert.equal(r.status, 200);
    const d = await json(r);
    const byId = new Map(d.scopes.map((row: any) => [row.scopeId, row]));

    assert.ok(byId.has("org:default-org"), "the org scope is always listed");
    assert.ok(byId.has("channel:C9"), "session scopes are listed");
    assert.ok(byId.has("personal:U1"), "every participant gets a personal-scope row, even with no memory yet");
    assert.ok(byId.has("personal:admin-alice"), "grant holders are listed even if they never spoke");

    const c9: any = byId.get("channel:C9");
    assert.equal(c9.hasMemory, true);
    assert.equal(c9.label, "#eng", "channel rows carry the human channel name");
    assert.ok(c9.bytes > 0);
    const u1: any = byId.get("personal:U1");
    assert.equal(u1.hasMemory, false);
    assert.equal(d.scopes[0].hasMemory, true, "scopes with notebooks sort first");

    assert.equal(
      (await fetch(`${s.base}/v1/admin/memory/scopes`, { headers: { "x-admin-actor": "nobody@default-org" } })).status,
      403,
      "org_admin-only",
    );
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "memory.scopes.read"),
      "the directory read is audited",
    );
  } finally {
    await s.close();
  }
});

test("memory routes 404 when no MemoryService is wired", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "memory-http-none-")) }));
  const server = createInsecureTestServer(built.app, { admin: built.admin, auditLog: built.auditLog });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/v1/memory?principalId=U1`)).status, 404);
    assert.equal((await fetch(`${base}/v1/admin/memory?scope=org:default-org`, { headers: ALICE_ADMIN })).status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
