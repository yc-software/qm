import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoreSearch, type SearchBackend } from "../src/search/core-search.ts";
import { createIntersectionBackend } from "../src/search/backends.ts";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { CAPABILITY_TTL_MS, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { artifactPath } from "../src/files/file-artifact-store.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

const principals = [
  { id: "alice@example.com", type: "internal" as const },
  { id: "bob@example.com", type: "internal" as const },
];
test("core search canonicalizes the principal floor and isolates failures", async () => {
  const seen: string[][] = [];
  const backend = (name: string, fail = false): SearchBackend => ({
    name,
    async search(r) {
      seen.push(r.principals.map((p) => p.id));
      if (fail) throw new Error("down");
      return [{ id: name, type: "page", snippet: r.query }];
    },
  });
  const result = await createCoreSearch([backend("one"), backend("bad", true), backend("two")]).search({
    query: "plan",
    principals: [principals[1]!, principals[0]!, principals[0]!],
  });
  assert.deepEqual(seen, Array(3).fill(["alice@example.com", "bob@example.com"]));
  assert.deepEqual(
    result.hits.map((h) => h.backend),
    ["one", "two"],
  );
  assert.deepEqual(result.failedBackends, ["bad"]);
});
test("intersection backend requires visibility to every principal", async () => {
  const backend = createIntersectionBackend({
    name: "files",
    key: (h) => h.id,
    searchForPrincipal: async (p) =>
      p.id.startsWith("alice")
        ? [
            { id: "shared", type: "file", snippet: "x" },
            { id: "private", type: "file", snippet: "x" },
          ]
        : [{ id: "shared", type: "file", snippet: "x" }],
  });
  assert.deepEqual(
    (await backend.search({ query: "x", principals, limit: 20 })).map((h) => h.id),
    ["shared"],
  );
});
test("POST /v1/search derives principals from capability and shared scopes fail closed", async () => {
  const secret = "search-route-secret".repeat(3);
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "search-")), signingSecret: secret }));
  await built.directory.replaceChannels(
    [
      { channelId: "C1", name: "private", isPrivate: true },
      { channelId: "C-ALICE", name: "alice-only", isPrivate: true },
    ],
    [
      ...principals.map((p) => ({ channelId: "C1", principalId: p.id })),
      { channelId: "C-ALICE", principalId: principals[0]!.id },
    ],
  );
  await built.app.ingestSurfaceEvents([
    { container: "C1", ts: "1", text: "pelican launch shared", kind: "channel" },
    { container: "C-ALICE", ts: "2", text: "pelican launch private", kind: "channel" },
    { container: "D-ALICE", ts: "3", text: "pelican launch dm", kind: "dm", members: [principals[0]!.id] },
  ]);
  const [fileId, orgFileId] = ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"];
  for (const [id, ownerScopeId] of [
    [fileId, scopeId("personal", principals[0]!.id)],
    [orgFileId, scopeId("org", "default-org")],
  ] as const)
    await built.files.put({
      id,
      ownerScopeId,
      createdBy: principals[0]!.id,
      name: `${id}.txt`,
      path: artifactPath(id, `${id}.txt`),
      mimetype: "text/plain",
      data: Buffer.from("the launch codename is pelican"),
      direction: "in",
    });
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: secret,
    auditLog: built.auditLog,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = async (members?: typeof principals, dm?: { botActor?: true }) =>
    mintCapabilityToken(
      {
        actorId: principals[0]!.id,
        scopeId: dm ? scopeId("personal", principals[0]!.id) : scopeId("channel", "C1"),
        ...(members ? { members } : {}),
        ...dm,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      secret,
    );
  const post = async (cap: string) =>
    fetch(`${base}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
      body: JSON.stringify({ query: "pelican" }),
    });
  try {
    const ok = await post(await token(principals));
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { hits: Array<{ id: string }> };
    assert.deepEqual(
      body.hits.map((hit) => hit.id).sort(),
      ["C1:1", orgFileId],
      "a message or file only one participant can see is never returned to the shared conversation",
    );

    const missing = await post(await token());
    assert.equal(missing.status, 409);
    assert.equal(((await missing.json()) as { error: string }).error, "principal_set_unavailable");

    const events = (await built.auditLog.events(tenant)).filter((e) => e.action === "search.query");
    assert.equal(events.length, 1, "a fail-closed request runs no search and records none");
    assert.match(events[0]!.detail ?? "", /"principals":\["alice@example.com","bob@example.com"\]/);
    assert.doesNotMatch(events[0]!.detail ?? "", /pelican/, "query text is not copied into the audit log");

    const inDm = async (dm: { botActor?: true }) =>
      ((await (await post(await token(undefined, dm))).json()) as { hits: Array<{ id: string }> }).hits
        .map((hit) => hit.id)
        .sort();
    assert.deepEqual(await inDm({}), [fileId, "C-ALICE:2", "C1:1", "D-ALICE:3", orgFileId]);
    assert.deepEqual(
      await inDm({ botActor: true }),
      ["C-ALICE:2", "C1:1", orgFileId],
      "bot work in a person's DM keeps rooms and org files but loses their own files and DM",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("file search retains common artifact identities when viewers own different copies", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "search-copies-")) }));
  const project = scopeId("group", "search-copy-project");
  const ids = ["shared-copy-alice", "shared-copy-bob"];
  for (const [index, author] of principals.entries()) {
    const id = ids[index]!;
    const ownerScopeId = scopeId("personal", author.id);
    await built.files.put({
      id,
      ownerScopeId,
      createdBy: author.id,
      createdInScope: project,
      name: "pelican.txt",
      path: artifactPath(id, "pelican.txt"),
      mimetype: "text/plain",
      data: Buffer.from("pelican launch"),
      direction: "in",
      createdAt: index + 1,
    });
    await built.acl.grant(tenant, {
      ownerScopeId,
      ref: id,
      granteeScopeId: scopeId("personal", principals[1 - index]!.id),
      permission: "read",
      grantedBy: author.id,
    });
  }
  const alice = await built.app.listFilesForViewer(tenant, principals[0]!.id);
  const bob = await built.app.listFilesForViewer(tenant, principals[1]!.id);
  assert.deepEqual(
    alice.owned.map((f) => f.id),
    [ids[0]],
  );
  assert.deepEqual(
    bob.owned.map((f) => f.id),
    [ids[1]],
  );
  const result = await built.app.search({ query: "pelican", principals });
  assert.deepEqual(
    result.hits
      .filter((hit) => hit.backend === "files")
      .map((hit) => hit.id)
      .sort(),
    ids,
  );
});

test("file search still reaches shared artifacts outside the first document page", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "search-shared-pages-")) }));
  const ownerScopeId = scopeId("personal", "carol@example.com");
  for (let n = 0; n < 205; n++) {
    const id = "shared-search-" + n;
    await built.files.put({
      id,
      path: artifactPath(id, "pelican.txt"),
      ownerScopeId,
      createdBy: "carol@example.com",
      name: "note.txt",
      mimetype: "text/plain",
      data: Buffer.from(n === 0 ? "pelican milestone" : "unrelated " + n),
      direction: "out",
      createdAt: n,
    });
    for (const person of principals)
      await built.acl.grant(tenant, {
        ownerScopeId,
        ref: id,
        granteeScopeId: scopeId("personal", person.id),
        permission: "read",
        grantedBy: "carol@example.com",
      });
  }
  const page = await built.app.listFilesForViewer(tenant, principals[0]!.id, { limit: 200 });
  assert.equal(page.shared.length, 200);
  assert.ok(page.nextCursor);
  assert.equal(
    page.shared.some((file) => file.id === "shared-search-0"),
    false,
  );
  const result = await built.app.search({ query: "pelican", principals });
  assert.deepEqual(
    result.hits.filter((hit) => hit.backend === "files").map((hit) => hit.id),
    ["shared-search-0"],
  );
});
