import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPostgresEnvironmentStore,
  EnvironmentShareDenied,
  resolveEnvironmentId,
  type EnvironmentStore,
} from "../src/environments/environment-store.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { scopeId } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

describe("environments (the computer a conversation points at)", () => {
  let t = 1_000;
  const now = (): number => ++t;
  const members = new Set<string>();
  const member = (principalId: string, scope: string) => `${principalId}@${scope}`;
  const join = (principalId: string, scope: string) => members.add(member(principalId, scope));
  const leave = (principalId: string, scope: string) => members.delete(member(principalId, scope));
  const store = (url = testDatabaseUrl()): EnvironmentStore =>
    createPostgresEnvironmentStore(url, {
      now,
      mayShare: async (principalId, scope) =>
        scope === scopeId("personal", principalId) || members.has(member(principalId, scope)),
    });

  it("an unattached scope resolves to its own default environment (id == scopeId)", async () => {
    const s = store();
    const scope = scopeId("channel", "C-eng");
    assert.equal(await resolveEnvironmentId(s, scope), scope);
  });

  it("resolveEnvironmentId is the identity when no store is wired (zero-migration default)", async () => {
    const scope = scopeId("personal", "U1");
    assert.equal(await resolveEnvironmentId(undefined, scope), scope);
  });

  it("the default environment's machine/volume names are exactly today's scope-keyed names", async () => {
    const scope = scopeId("channel", "C-eng");
    const envId = await resolveEnvironmentId(store(), scope);
    assert.equal(sandboxScopeName("qm", envId), sandboxScopeName("qm", scope));
  });

  it("an attachment redirects the machine + backup key to the environment id", async () => {
    const s = store();
    const scope = scopeId("channel", "C-eng");
    const owner = scopeId("personal", "U-owner");
    await s.create({ id: owner, name: "prod", ownerActorId: "U-owner" });
    await s.attach(scope, owner, "U-owner");

    const resolved = await resolveEnvironmentId(s, scope);
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

    const ra = await resolveEnvironmentId(s, a);
    const rb = await resolveEnvironmentId(s, b);
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

  it("a room's environment shared by a member stops resolving once that member leaves the room", async () => {
    const s = store();
    const room = scopeId("channel", "C-room");
    const dm = scopeId("personal", "U-mallory");
    const otherRoom = scopeId("channel", "C-other");
    join("U-mallory", room);
    await s.create({ id: room, name: "room-box", ownerActorId: "U-mallory" });
    await s.attach(dm, room, "U-mallory");
    await s.attach(otherRoom, room, "U-mallory");
    assert.equal(await resolveEnvironmentId(s, dm), room, "the share works while it stands");
    assert.equal(await resolveEnvironmentId(s, otherRoom), room);

    leave("U-mallory", room);
    assert.equal(await resolveEnvironmentId(s, dm), dm, "the DM falls back to its own computer");
    assert.equal(await resolveEnvironmentId(s, otherRoom), otherRoom, "so does the other room");
    assert.deepEqual(await s.attachmentsFor(room), [], "a lapsed share is not reported as an attachment");
    assert.equal(await resolveEnvironmentId(s, room), room, "the owning room itself is unaffected");
  });

  it("the person who named an environment has no authority over it after leaving its room", async () => {
    const s = store();
    const room = scopeId("channel", "C-named");
    join("U-namer", room);
    await s.create({ id: room, name: "named-box", ownerActorId: "U-namer" });
    leave("U-namer", room);
    await assert.rejects(s.attach(scopeId("personal", "U-namer"), room, "U-namer"), EnvironmentShareDenied);
    assert.equal(await s.getAttachment(scopeId("personal", "U-namer")), null);
  });

  it("any current member of the owning room may share it, regardless of who named it", async () => {
    const s = store();
    const room = scopeId("channel", "C-team");
    join("U-namer", room);
    join("U-peer", room);
    await s.create({ id: room, name: "team-box", ownerActorId: "U-namer" });
    await s.attach(scopeId("personal", "U-peer"), room, "U-peer");
    assert.equal(await resolveEnvironmentId(s, scopeId("personal", "U-peer")), room);
    leave("U-namer", room);
    assert.equal(
      await resolveEnvironmentId(s, scopeId("personal", "U-peer")),
      room,
      "the namer leaving does not touch a share another member made",
    );
  });

  it("attachments written before shares were checked are judged as shares when read", async () => {
    const url = testDatabaseUrl();
    const legacy = createPostgresEnvironmentStore(url, { now, mayShare: async () => true });
    const room = scopeId("channel", "C-legacy");
    const dm = scopeId("personal", "U-former");
    await legacy.create({ id: room, name: "legacy-box", ownerActorId: "U-former" });
    await legacy.attach(dm, room, "U-former");

    const s = store(url);
    assert.equal(await s.getAttachment(dm), null);
    assert.deepEqual(await s.attachmentsFor(room), []);
    assert.equal(
      await resolveEnvironmentId(s, dm),
      dm,
      "a row its grantor can no longer stand behind is never followed",
    );
    join("U-former", room);
    assert.equal(await resolveEnvironmentId(s, dm), room, "a row whose grantor is still a member keeps working");
  });
});
