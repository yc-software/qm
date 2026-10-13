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

test("a user reads and curates their OWN personal memory (personal-scoped, boundary-safe)", async () => {
  const s = start();
  try {
    const empty = await fetch(`${s.base}/v1/memory?principalId=U1`);
    assert.equal(empty.status, 200);
    const emptyHead = await json(empty);
    assert.equal(emptyHead.content, "", "no memory yet → empty");
    assert.match(emptyHead.revision, /^[a-f0-9]{64}$/, "even an empty notebook has a usable revision token");

    await s.built.memory.capture(scopeId("personal", "U1"), ["Prefers terse replies"], Date.parse("2026-05-31"));
    const seeded = await json(await fetch(`${s.base}/v1/memory?principalId=U1`));
    assert.match(seeded.content, /Prefers terse replies/, "captured fact is visible to the owner");

    const put = await fetch(`${s.base}/v1/memory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", revision: seeded.revision, content: "# Memory\n\n- I work in PT\n" }),
    });
    assert.equal(put.status, 200);
    assert.equal(
      (await json(await fetch(`${s.base}/v1/memory?principalId=U1`))).content,
      "# Memory\n\n- I work in PT\n",
    );

    assert.equal(
      (await json(await fetch(`${s.base}/v1/memory?principalId=U2`))).content,
      "",
      "another user's memory is separate",
    );

    const onDisk = await s.built.workspace.read(scopeId("personal", "U1"), "memory/MEMORY.md");
    assert.equal(JSON.parse(onDisk!).version, 1);
    assert.equal(await s.built.memory.read(scopeId("personal", "U1")), "# Memory\n\n- I work in PT\n");

    const actions = (await s.built.auditLog.events()).filter((e) => e.principalId === "U1").map((e) => e.action);
    assert.ok(
      actions.includes("memory.self.read") && actions.includes("memory.self.update"),
      "self memory access is audited",
    );
  } finally {
    await s.close();
  }
});

test("user memory rejects a missing principal or non-string content", async () => {
  const s = start();
  try {
    assert.equal((await fetch(`${s.base}/v1/memory`)).status, 400, "GET needs principalId");
    assert.equal(
      (
        await fetch(`${s.base}/v1/memory`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      400,
      "PUT needs principalId",
    );
    const noContent = await fetch(`${s.base}/v1/memory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    assert.equal(noContent.status, 400, "PUT needs content");
  } finally {
    await s.close();
  }
});

test("revisioned saves reject stale editors without losing a newer capture", async () => {
  const s = start();
  try {
    const head = await json(await fetch(`${s.base}/v1/memory?principalId=U1`));
    await s.built.memory.capture(scopeId("personal", "U1"), ["New fact from another conversation"], Date.now());
    const stale = await fetch(`${s.base}/v1/memory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", revision: head.revision, content: "# Memory\n\n- stale edit\n" }),
    });
    assert.equal(stale.status, 409);
    assert.match((await json(stale)).content, /New fact from another conversation/);
    assert.match(await s.built.memory.read(scopeId("personal", "U1")), /New fact from another conversation/);
  } finally {
    await s.close();
  }
});

test("a stale editor must send its read revision and cannot overwrite a newer save", async () => {
  const s = start();
  try {
    const put = (body: object) =>
      fetch(`${s.base}/v1/memory`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principalId: "U1", ...body }),
      });
    const r1 = (await json(await fetch(`${s.base}/v1/memory?principalId=U1`))).revision;
    const byB = await put({ revision: r1, content: "# Memory\n\n- B's edit\n" });
    assert.equal(byB.status, 200);
    const r2 = (await json(byB)).revision;

    assert.equal((await put({ content: "# Memory\n\n- A's stale edit\n" })).status, 428);
    assert.equal((await put({ revision: "", content: "# Memory\n\n- A's stale edit\n" })).status, 409);
    const conflict = await put({ revision: r1, content: "# Memory\n\n- A's stale edit\n" });
    assert.equal(conflict.status, 409);
    assert.match((await json(conflict)).content, /B's edit/);
    assert.equal(await s.built.memory.read(scopeId("personal", "U1")), "# Memory\n\n- B's edit\n");

    assert.equal((await put({ revision: r2, content: "# Memory\n\n- A's merged edit\n" })).status, 200);
    assert.equal(await s.built.memory.read(scopeId("personal", "U1")), "# Memory\n\n- A's merged edit\n");
  } finally {
    await s.close();
  }
});

test("an admin views and curates any scope's memory; the write replaces the notebook", async () => {
  const s = start();
  try {
    const scope = "channel:C9";
    await s.built.memory.capture(scope, ["The standup is at 10am"], Date.parse("2026-05-31"));

    const read = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(scope)}`, { headers: ALICE_ADMIN });
    assert.equal(read.status, 200);
    const d = await json(read);
    assert.equal(d.scopeId, scope);
    assert.match(d.content, /standup is at 10am/);

    const adminPut = (body: object) =>
      fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(scope)}`, {
        method: "PUT",
        headers: { ...ALICE_ADMIN, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await adminPut({ content: "# Memory\n\n- Standup moved to 9:30\n" })).status, 428);
    const put = await adminPut({ content: "# Memory\n\n- Standup moved to 9:30\n", revision: d.revision });
    assert.equal(put.status, 200);
    const stale = await adminPut({ content: "# Memory\n\n- stale admin edit\n", revision: d.revision });
    assert.equal(stale.status, 409);
    assert.doesNotMatch(await stale.text(), /Standup moved/);
    const after = await json(
      await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(scope)}`, { headers: ALICE_ADMIN }),
    );
    assert.equal(after.content, "# Memory\n\n- Standup moved to 9:30\n");

    await adminPut({ content: "   \n", revision: after.revision });
    assert.equal(
      (
        await json(
          await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(scope)}`, { headers: ALICE_ADMIN }),
        )
      ).content,
      "",
    );

    const actions = (await s.built.auditLog.events()).map((e) => e.action);
    assert.ok(actions.includes("memory.read") && actions.includes("memory.update"), "admin memory access is audited");
  } finally {
    await s.close();
  }
});

test("admin memory is authz-gated (authz is the boundary) and needs a scope", async () => {
  const s = start();
  try {
    const scope = "personal:U1";
    assert.equal(
      (
        await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(scope)}`, {
          headers: { "x-admin-actor": "nobody@default-org" },
        })
      ).status,
      403,
    );
    const denied = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(scope)}`, {
      method: "PUT",
      headers: { "x-admin-actor": "nobody@default-org", "content-type": "application/json" },
      body: JSON.stringify({ content: "evil" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(await s.built.workspace.read(scope, "memory/MEMORY.md"), null, "a denied PUT cannot write memory");
    assert.equal((await fetch(`${s.base}/v1/admin/memory`, { headers: ALICE_ADMIN })).status, 400);
    assert.equal(
      (
        await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(scope)}`, {
          method: "PUT",
          headers: { ...ALICE_ADMIN, "content-type": "application/json" },
          body: JSON.stringify({ content: 42 }),
        })
      ).status,
      400,
    );
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
