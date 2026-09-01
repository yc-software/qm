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
  const seen: string[][] = [];
  const external: SearchBackend = {
    name: "external",
    async search(r) {
      seen.push(r.principals.map((p) => p.id));
      return [];
    },
  };
  const secret = "search-route-secret".repeat(3);
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "search-")), signingSecret: secret }), {
    searchBackends: [external],
  });
  await built.directory.replaceChannels(
    [{ channelId: "C1", name: "private", isPrivate: true }],
    principals.map((p) => ({ channelId: "C1", principalId: p.id })),
  );
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
      body: JSON.stringify({ query: "plan" }),
    });
  try {
    assert.equal((await post(await token(principals))).status, 200);
    assert.deepEqual(seen, [["alice@example.com", "bob@example.com"]]);
    assert.equal((await post(await token())).status, 409);
    assert.equal(seen.length, 1);
    const event = (await built.auditLog.events()).find((e) => e.action === "search.query");
    assert.ok(event);
    assert.doesNotMatch(event.detail ?? "", /plan/);
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
