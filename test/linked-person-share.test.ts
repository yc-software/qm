import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import type { PutFileInput } from "../src/files/file-artifact-store.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import { memberBrainId, memberBrainOwner, type MemoryRegistry } from "../src/memory/registry.ts";
import { entitledScopes } from "../src/resolution/context-filter.ts";
import { scopeId } from "../src/types.ts";
import { testAdvisoryLock, testDatabaseUrl, testMap } from "./support/test-database.ts";

const EMAIL = "jordan@acme.test";
const OIDC = "oidc:abc:jordan";
const OTHER = "casey@acme.test";
const HOME = scopeId("personal", EMAIL);
const LINKED = scopeId("personal", OIDC);
const STRANGER = scopeId("personal", OTHER);

function link() {
  installPrincipalLinks({
    canonical: (key) => (key === OIDC || key === EMAIL ? EMAIL : undefined),
    aliases: (key) => (key === EMAIL ? [OIDC] : []),
  });
}

afterEach(() => installPrincipalLinks(null));

const texts = async (memory: MemoryService, scope: string) => (await memory.facts!(scope)).map((f) => f.text);

test("a notebook written under a linked sign-in is the person's notebook; new facts land on the canonical scope", async () => {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  await memory.capture(LINKED, ["Prefers tea"], 1);
  await memory.capture(STRANGER, ["Prefers coffee"], 1);
  assert.deepEqual(await texts(memory, HOME), [], "unlinked sign-ins keep separate notebooks");
  link();
  assert.deepEqual(await texts(memory, HOME), ["Prefers tea"]);
  assert.equal(await memory.capture(HOME, ["Prefers tea"], 2), 0, "the linked fact dedupes the same claim");
  await memory.capture(LINKED, ["Lives in Oakland"], 3);
  installPrincipalLinks(null);
  assert.deepEqual(await texts(memory, HOME), ["Lives in Oakland"]);
  link();
  const tea = (await memory.facts!(HOME)).find((f) => f.text === "Prefers tea")!;
  await memory.edit!(HOME, [{ id: tea.id, text: "Prefers green tea" }]);
  await memory.delete!(LINKED, [(await memory.facts!(HOME)).find((f) => f.text === "Lives in Oakland")!.id]);
  assert.deepEqual(await texts(memory, LINKED), ["Prefers green tea"]);
  assert.deepEqual(await texts(memory, STRANGER), ["Prefers coffee"]);
});

test("files under a linked sign-in list with the person's files, and new files land on the canonical scope", async () => {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const put = (id: string, ownerScopeId: string, over: Partial<PutFileInput> = {}) =>
    files.put({
      id,
      ownerScopeId,
      createdBy: OIDC,
      name: `${id}.txt`,
      path: `artifacts/${id}.txt`,
      mimetype: "text/plain",
      data: Buffer.from(id),
      direction: "in",
      createdInScope: ownerScopeId,
      createdAt: 1,
      ...over,
    });
  const ids = async (opts = {}) => (await files.listOwnedByScopes([HOME], opts)).files.map((f) => f.id);
  await put("before", LINKED);
  await put("theirs", STRANGER);
  assert.deepEqual(await ids(), []);
  link();
  assert.deepEqual(await ids(), ["before"]);
  assert.deepEqual(await ids({ createdInScope: HOME }), ["before"]);
  const { artifact } = await put("after", LINKED, { createdAt: 5 });
  assert.equal(artifact.ownerScopeId, HOME);
  const reused = await put("again", HOME, { path: "artifacts/before.txt", reuseExistingPath: true });
  assert.equal(reused.artifact.id, "before");
});

test("skills saved under a linked sign-in are visible from the person's scope", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), backing: testMap() });
  const manifest = { name: "standup", description: "d", requiredCapabilities: [], body: "# Standup" };
  const s = await skills.create({ scopeId: LINKED, manifest, createdBy: OIDC });
  await skills.review(s.id, "system:reviewer", []);
  await skills.publish(s.id);
  assert.equal((await skills.visibleFor([HOME])).length, 0);
  link();
  assert.deepEqual(
    (await skills.visibleFor([HOME])).map((r) => r.skill?.id),
    [s.id],
  );
  assert.equal((await skills.resolve("standup", [HOME])).skill?.id, s.id);
  assert.equal((await skills.visibleFor([STRANGER])).length, 0);
});

test("a memory route or member brain bound to a linked sign-in serves the person, and context entitlement covers both", async () => {
  const seen: string[] = [];
  const provider: MemoryService = {
    recall: async (scope) => (seen.push(scope), []),
    capture: async () => 0,
    query: async () => [],
    read: async () => "",
  };
  const routed = createRoutedMemoryService({
    providers: { brain: provider },
    routes: [{ provider: "brain", scopes: [LINKED] }],
  });
  const record = {
    brains: [{ id: memberBrainId(OIDC), owner: OIDC, updatedAt: 1 }],
    bindings: [],
  } as unknown as MemoryRegistry;
  const entitled = () =>
    entitledScopes(false)({ id: EMAIL, type: "internal" }, "channel:C1", "org:default-org").filter((s) =>
      s.startsWith("personal:"),
    );
  assert.equal(memberBrainOwner(record, EMAIL), EMAIL);
  assert.deepEqual(entitled(), [HOME]);
  await routed.recall(HOME);
  assert.deepEqual(seen, []);
  link();
  assert.equal(memberBrainOwner(record, EMAIL), OIDC);
  assert.deepEqual(entitled(), [HOME, LINKED]);
  await routed.recall(HOME);
  assert.deepEqual(seen, [HOME]);
});
