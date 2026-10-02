import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryEnvironmentStore, resolveEnvironmentId } from "../src/environments/environment-store.ts";
import type { CanWriteScope } from "../src/resolution/scope-membership.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { scopeId } from "../src/types.ts";

describe("environments (the computer a conversation points at)", () => {
  let t = 1_000;
  const now = (): number => ++t;
  const store = (): ReturnType<typeof createMemoryEnvironmentStore> => createMemoryEnvironmentStore({ now });
  const members =
    (roster: Record<string, readonly string[]>): CanWriteScope =>
    async (principalId, targetScope) =>
      (roster[targetScope] ?? []).includes(principalId);
  const nobody = members({});

  it("an unattached scope resolves to its own default environment (id == scopeId)", async () => {
    const s = store();
    const scope = scopeId("channel", "C-eng");
    assert.equal(await resolveEnvironmentId(s, scope, nobody), scope);
  });

  it("resolveEnvironmentId is the identity when no store is wired (zero-migration default)", async () => {
    const scope = scopeId("personal", "U1");
    assert.equal(await resolveEnvironmentId(undefined, scope, nobody), scope);
  });

  it("the default environment's machine/volume names are exactly today's scope-keyed names", async () => {
    const scope = scopeId("channel", "C-eng");
    const envId = await resolveEnvironmentId(store(), scope, nobody);
    assert.equal(sandboxScopeName("qm", envId), sandboxScopeName("qm", scope));
  });

  it("an attachment redirects the machine + backup key to the environment id", async () => {
    const s = store();
    const scope = scopeId("channel", "C-eng");
    const owner = scopeId("personal", "U-owner");
    await s.create({ id: owner, name: "prod", ownerActorId: "U-owner" });
    await s.attach(scope, owner, "U-owner");

    const resolved = await resolveEnvironmentId(s, scope, members({ [owner]: ["U-owner"] }));
    assert.equal(resolved, owner, "the attached scope provisions through the environment id");
    assert.equal(sandboxScopeName("qm", resolved), sandboxScopeName("qm", owner));
    assert.notEqual(sandboxScopeName("qm", resolved), sandboxScopeName("qm", scope));
  });

  it("two scopes attached to one environment resolve to the SAME id (advisory lock keys on it)", async () => {
    const s = store();
    const env = scopeId("personal", "U-owner");
    await s.create({ id: env, name: "prod", ownerActorId: "U-owner" });
    const a = scopeId("channel", "C-a");
    const b = scopeId("channel", "C-b");
    await s.attach(a, env, "U-owner");
    await s.attach(b, env, "U-owner");

    const shared = members({ [env]: ["U-owner"] });
    const ra = await resolveEnvironmentId(s, a, shared);
    const rb = await resolveEnvironmentId(s, b, shared);
    assert.equal(ra, rb);
    assert.equal(sandboxScopeName("qm", ra), sandboxScopeName("qm", rb));
  });

  it("create is idempotent on id (re-naming the same default env returns the first record)", async () => {
    const s = store();
    const id = scopeId("channel", "C-eng");
    const first = await s.create({ id, name: "prod", ownerActorId: "U1" });
    const second = await s.create({ id, name: "staging", ownerActorId: "U2" });
    assert.equal(second.name, "prod", "the original name + owner stand");
    assert.equal(second.ownerActorId, "U1");
    assert.equal(first.createdAt, second.createdAt);
  });

  it("attachmentsFor lists every scope pointing at an environment", async () => {
    const s = store();
    const env = scopeId("personal", "U-owner");
    await s.create({ id: env, name: "prod", ownerActorId: "U-owner" });
    await s.attach(scopeId("channel", "C-a"), env, "U-owner");
    await s.attach(scopeId("channel", "C-b"), env, "U-owner");
    const attached = (await s.attachmentsFor(env)).map((a) => a.scopeId).sort();
    assert.deepEqual(attached, [scopeId("channel", "C-a"), scopeId("channel", "C-b")].sort());
  });

  it("a cross-scope attachment stops resolving once its granter leaves the owning scope (a removed member keeps the room's computer)", async () => {
    const s = store();
    const room = scopeId("channel", "C-room");
    const dm = scopeId("personal", "U-member");
    await s.create({ id: room, name: "room-box", ownerActorId: "U-member" });
    await s.attach(dm, room, "U-member");

    assert.equal(
      await resolveEnvironmentId(s, dm, members({ [room]: [] })),
      dm,
      "the room's computer is denied; the scope falls back to its own environment",
    );
  });

  it("a cross-scope attachment resolves while its granter is still in the owning scope (the re-check breaks a live share)", async () => {
    const s = store();
    const room = scopeId("channel", "C-room");
    const dm = scopeId("personal", "U-member");
    await s.create({ id: room, name: "room-box", ownerActorId: "U-member" });
    await s.attach(dm, room, "U-member");

    assert.equal(await resolveEnvironmentId(s, dm, members({ [room]: ["U-member"] })), room);
  });

  it("a scope attached to its own environment never consults the share check (the re-check locks a room out of its own computer)", async () => {
    const s = store();
    const room = scopeId("channel", "C-room");
    await s.create({ id: room, name: "room-box", ownerActorId: "U-member" });
    await s.attach(room, room, "U-member");

    assert.equal(await resolveEnvironmentId(s, room, undefined), room, "a scope needs no share to use its own box");
  });

  it("a cross-scope attachment is refused when no membership check is wired (an unverifiable share is followed anyway)", async () => {
    const s = store();
    const room = scopeId("channel", "C-room");
    const dm = scopeId("personal", "U-member");
    await s.create({ id: room, name: "room-box", ownerActorId: "U-member" });
    await s.attach(dm, room, "U-member");

    await assert.rejects(() => resolveEnvironmentId(s, dm, undefined), /no membership check is wired/);
  });
});
