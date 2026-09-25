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
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { CAPABILITY_TTL_MS, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { artifactPath } from "../src/files/file-artifact-store.ts";
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
  ]);
  const server = createServer(built.app, { signingSecret: secret, auditLog: built.auditLog });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = async (members?: typeof principals) =>
    mintCapabilityToken(
      {
        actorId: principals[0]!.id,
        scopeId: scopeId("channel", "C1"),
        ...(members ? { members } : {}),
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
    const body = (await ok.json()) as { hits: Array<{ id: string; backend: string }> };
    assert.deepEqual(
      body.hits.filter((hit) => hit.backend === "slack").map((hit) => hit.id),
      ["C1:1"],
      "a message only one participant can see is never returned to the shared conversation",
    );

    const missing = await post(await token());
    assert.equal(missing.status, 409);
    assert.equal(((await missing.json()) as { error: string }).error, "principal_set_unavailable");

    const events = (await built.auditLog.events()).filter((e) => e.action === "search.query");
    assert.equal(events.length, 1, "a fail-closed request runs no search and records none");
    assert.match(events[0]!.detail ?? "", /"principals":\["alice@example.com","bob@example.com"\]/);
    assert.doesNotMatch(events[0]!.detail ?? "", /pelican/, "query text is not copied into the audit log");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("file backend applies the principal visibility intersection to real file rows", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "search-files-")) }));
  const id = "0123456789abcdef0123456789abcdef";
  await built.files.put({
    id,
    ownerScopeId: scopeId("personal", principals[0]!.id),
    createdBy: principals[0]!.id,
    name: "notes.txt",
    path: artifactPath(id, "notes.txt"),
    mimetype: "text/plain",
    data: Buffer.from("the launch codename is pelican"),
    direction: "in",
  });

  const mine = await built.app.search("pelican", [principals[0]!]);
  assert.deepEqual(
    mine.hits.filter((hit) => hit.backend === "files").map((hit) => hit.id),
    [id],
  );

  const shared = await built.app.search("pelican", principals);
  assert.deepEqual(
    shared.hits.filter((hit) => hit.backend === "files"),
    [],
    "a file private to one participant is excluded from a shared principal floor",
  );
});

test("slack backend intersects private-channel visibility across all principals", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "search-slack-")) }));
  await built.directory.replaceChannels(
    [
      { channelId: "C-SHARED", name: "shared", isPrivate: true },
      { channelId: "C-ALICE", name: "alice-only", isPrivate: true },
    ],
    [
      { channelId: "C-SHARED", principalId: principals[0]!.id },
      { channelId: "C-SHARED", principalId: principals[1]!.id },
      { channelId: "C-ALICE", principalId: principals[0]!.id },
    ],
  );
  await built.app.ingestSurfaceEvents([
    { container: "C-SHARED", ts: "1", text: "pelican launch shared", kind: "channel" },
    { container: "C-ALICE", ts: "2", text: "pelican launch private", kind: "channel" },
  ]);

  const hits = await built.app.search("pelican", principals);
  assert.deepEqual(
    hits.hits.filter((hit) => hit.backend === "slack").map((hit) => hit.id),
    ["C-SHARED:1"],
  );
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
      path: id,
      mimetype: "text/plain",
      data: Buffer.from("pelican launch"),
      direction: "in",
      createdAt: index + 1,
    });
    await built.acl.grant({
      ownerScopeId,
      ref: id,
      granteeScopeId: scopeId("personal", principals[1 - index]!.id),
      permission: "read",
      grantedBy: author.id,
    });
  }
  const alice = await built.app.listFilesForViewer(principals[0]!.id);
  const bob = await built.app.listFilesForViewer(principals[1]!.id);
  assert.deepEqual(
    alice.owned.map((f) => f.id),
    [ids[0]],
  );
  assert.deepEqual(
    bob.owned.map((f) => f.id),
    [ids[1]],
  );
  const result = await built.app.search("pelican", principals);
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
      path: id,
      ownerScopeId,
      createdBy: "carol@example.com",
      name: "note.txt",
      mimetype: "text/plain",
      data: Buffer.from(n === 0 ? "pelican milestone" : "unrelated " + n),
      direction: "out",
      createdAt: n,
    });
    for (const person of principals)
      await built.acl.grant({
        ownerScopeId,
        ref: id,
        granteeScopeId: scopeId("personal", person.id),
        permission: "read",
        grantedBy: "carol@example.com",
      });
  }
  const page = await built.app.listFilesForViewer(principals[0]!.id, { limit: 200 });
  assert.equal(page.shared.length, 200);
  assert.ok(page.nextCursor);
  assert.equal(
    page.shared.some((file) => file.id === "shared-search-0"),
    false,
  );
  const result = await built.app.search("pelican", principals);
  assert.deepEqual(
    result.hits.filter((hit) => hit.backend === "files").map((hit) => hit.id),
    ["shared-search-0"],
  );
});
