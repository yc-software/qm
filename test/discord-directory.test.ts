import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createDiscordCoreClient } from "../src/api/discord-core-client.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { createDirectorySync, type DirectorySyncDeps } from "../src/discord/directory.ts";
import type { ActorAssertion } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";

afterEach(() => installPrincipalLinks(null));

const actors: Record<string, ActorAssertion> = {
  "1": { externalId: "discord:1", displayName: "Ada" },
  "2": { externalId: "discord:2", displayName: "Guest", isExternalGuest: true },
  "3": { externalId: "discord:3", displayName: "Robot", isBot: true },
};

function syncDeps(over: Partial<DirectorySyncDeps> = {}) {
  const pushed: unknown[][] = [];
  const deps: DirectorySyncDeps = {
    ready: () => true,
    people: () => [
      { userId: "1", avatarUrl: "https://cdn.example/1.png" },
      { userId: "2", avatarUrl: "https://cdn.example/2.png" },
      { userId: "3", avatarUrl: "https://cdn.example/3.png" },
    ],
    classify: async (id) => actors[id]!,
    hold: (fn) => fn(new Promise(() => {})),
    push: async (members) => void pushed.push(members),
    ...over,
  };
  return { deps, pushed };
}

test("directory sync pushes only internal humans with name and avatar", async () => {
  const { deps, pushed } = syncDeps();
  await createDirectorySync(deps)();
  assert.deepEqual(pushed, [
    [{ principalId: "discord:1", displayName: "Ada", type: "internal", avatarUrl: "https://cdn.example/1.png" }],
  ]);
});

test("directory sync waits for hydrated members and for the lease", async () => {
  const notReady = syncDeps({ ready: () => false });
  await createDirectorySync(notReady.deps)();
  assert.deepEqual(notReady.pushed, []);

  const heldElsewhere = syncDeps({ hold: async () => null });
  await createDirectorySync(heldElsewhere.deps)();
  assert.deepEqual(heldElsewhere.pushed, []);
});

test("directory sync is single-flight", async () => {
  let releaseClassify!: () => void;
  const gate = new Promise<void>((resolve) => (releaseClassify = resolve));
  let classified = 0;
  const { deps, pushed } = syncDeps({
    classify: async (id) => {
      classified++;
      await gate;
      return actors[id]!;
    },
  });
  const sync = createDirectorySync(deps);
  const first = sync();
  const second = sync();
  releaseClassify();
  await Promise.all([first, second]);
  assert.equal(pushed.length, 1);
  assert.equal(classified, 3);
});

test("the Slack swap and the Discord swap each leave the other's rows alone", async () => {
  const store = createPostgresDirectoryStore(testDatabaseUrl());
  const slack = { principalId: "U1", displayName: "Slack Sam", type: "internal" as const };
  const discord = { principalId: "discord:9", displayName: "Disc Dee", type: "internal" as const };
  await store.replace([slack]);
  await store.replaceDiscord([discord]);
  await store.replace([{ ...slack, displayName: "Slack Sam 2" }, discord]);
  assert.deepEqual((await store.list()).map((m) => m.principalId).sort(), ["U1", "discord:9"]);
  assert.equal((await store.get("discord:9"))?.displayName, "Disc Dee");
  await store.replaceDiscord([]);
  assert.deepEqual(
    (await store.list()).map((m) => m.principalId),
    ["U1"],
  );
});

test("a Slack directory push neither deactivates nor lists Discord members, and Discord members resolve by name", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "discord-directory-")) }));
  const core = createDiscordCoreClient({
    app: built.app,
    identity: built.identity,
    runs: { onTerminal: () => {} },
  } as never);
  await core.syncDirectory([
    { principalId: "discord:7", displayName: "Zed Discord", type: "internal", avatarUrl: "https://cdn.example/7.png" },
  ]);
  await built.app.upsertDirectory([{ principalId: "U1", displayName: "Una Slack", type: "internal" }], 1);
  await built.app.upsertDirectory([{ principalId: "U1", displayName: "Una Slack", type: "internal" }], 2);

  assert.equal(built.identity.classify("discord:7").type, "internal");
  const found = await built.app.resolveRecipient("Zed");
  assert.equal(found.kind, "one");
  if (found.kind === "one") assert.equal(found.member.avatarUrl, "https://cdn.example/7.png");
  assert.equal((await built.app.directoryMembers()).length, 2);
});

test("a linked Discord member is listed only when its QM principal has no entry of its own", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "discord-directory-linked-")) }));
  installPrincipalLinks(built.principalLinks);
  const core = createDiscordCoreClient({
    app: built.app,
    identity: built.identity,
    runs: { onTerminal: () => {} },
  } as never);
  await built.principalLinks.link({
    principalId: "discord:1",
    canonicalId: "ann@example.test",
    evidence: "test",
    linkedBy: "ann@example.test",
  });
  await built.principalLinks.link({
    principalId: "discord:2",
    canonicalId: "bob@example.test",
    evidence: "test",
    linkedBy: "bob@example.test",
  });
  await built.app.upsertDirectory([{ principalId: "ann@example.test", displayName: "Ann", type: "internal" }]);
  const row = (id: string) => ({ principalId: id, displayName: `n${id}`, type: "internal" as const });
  await core.syncDirectory([row("discord:1"), row("discord:2"), row("discord:3")]);
  assert.deepEqual((await built.app.directoryMembers()).map((m) => m.principalId).sort(), [
    "ann@example.test",
    "discord:2",
    "discord:3",
  ]);
  await core.syncDirectory([row("discord:1"), row("discord:2"), row("discord:3")]);
  assert.equal((await built.app.directoryMembers()).length, 3);
});

test("a linked Discord member whose QM principal is only an identity entry keeps its Discord row", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "discord-directory-identity-")) }));
  installPrincipalLinks(built.principalLinks);
  const core = createDiscordCoreClient({
    app: built.app,
    identity: built.identity,
    runs: { onTerminal: () => {} },
  } as never);
  await built.principalLinks.link({
    principalId: "discord:1",
    canonicalId: "guest@example.test",
    evidence: "test",
    linkedBy: "guest@example.test",
  });
  await built.identity.putExternalMember({
    email: "guest@example.test",
    role: "member",
    expiresAt: Date.now() + 100_000,
    invitedBy: "admin",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.ok((await built.app.directoryMembers()).some((m) => m.principalId === "guest@example.test"));
  await core.syncDirectory([{ principalId: "discord:1", displayName: "Gus", type: "internal" }]);
  assert.ok((await built.directory.list()).some((m) => m.principalId === "discord:1"));
});

test("a directory push is dropped when the lease is lost while members are classified", async () => {
  let loseLease!: () => void;
  const lost = new Promise<void>((resolve) => (loseLease = resolve));
  const { deps, pushed } = syncDeps({
    classify: async (id) => {
      loseLease();
      await lost;
      return actors[id]!;
    },
    hold: (fn) => fn(lost),
  });
  await createDirectorySync(deps)();
  assert.deepEqual(pushed, []);
});

test("members are classified only while the lease is held", async () => {
  let classified = 0;
  const { deps } = syncDeps({
    classify: async (id) => (classified++, actors[id]!),
    hold: async () => null,
  });
  await createDirectorySync(deps)();
  assert.equal(classified, 0);
});
