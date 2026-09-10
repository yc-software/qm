import assert from "node:assert/strict";
import type { FileArtifactStore, PutFileInput } from "../../src/files/file-artifact-store.ts";
import { scopeId } from "../../src/types.ts";

export async function assertDocumentListing(store: FileArtifactStore): Promise<void> {
  const mine = scopeId("personal", "documents-owner");
  const teammate = scopeId("personal", "documents-teammate");
  const project = scopeId("group", "documents-project");
  const elsewhere = scopeId("group", "documents-elsewhere");
  const put = (id: string, text: string, at: number, extra: Partial<PutFileInput> = {}) =>
    store.put({
      id,
      name: "report.txt",
      path: `artifacts/${id}/report.txt`,
      ownerScopeId: mine,
      createdBy: "documents-owner",
      createdInScope: project,
      direction: "out",
      mimetype: "text/plain",
      data: Buffer.from(text),
      createdAt: at,
      ...extra,
    });
  const hidden = (await put("hidden", "same", 1, { ownerScopeId: teammate })).artifact;
  const shared = (await put("shared", "same", 2, { ownerScopeId: teammate })).artifact;
  await put("owned", "same", 3);
  await put("owned-copy", "same", 9);
  const second = (await put("second", "different", 4, { ownerScopeId: teammate })).artifact;
  await put("second-copy", "different", 8, { ownerScopeId: teammate });
  const disabled = (await put("disabled", "same", 0)).artifact;
  await store.setEnabled(disabled.id, false);
  await put("other-scope", "same", 5, { createdInScope: elsewhere });
  const refs = [shared, second].map(({ ownerScopeId, path }) => ({ ownerScopeId, path }));
  assert.deepEqual((await store.listDocuments([], [], { limit: 1 })).files, []);
  assert.deepEqual(
    (await store.listDocuments([], refs, { createdInScope: project })).files.map((f) => f.id),
    ["second", "shared"],
  );
  const first = await store.listDocuments([mine], refs, { createdInScope: project, limit: 1 });
  assert.deepEqual(
    first.files.map((f) => f.id),
    ["second"],
  );
  assert.ok(first.nextCursor);
  await put("second-later-copy", "different", 100, { ownerScopeId: teammate });
  const next = await store.listDocuments(
    [mine],
    [...refs, { ownerScopeId: teammate, path: "artifacts/second-later-copy/report.txt" }],
    {
      createdInScope: project,
      limit: 1,
      cursor: first.nextCursor,
    },
  );
  assert.deepEqual(
    next.files.map((f) => f.id),
    ["owned"],
    "an owned copy wins over a shared copy even on a later page",
  );
  assert.equal(next.nextCursor, undefined, "new duplicate turns neither repeat nor displace documents across pages");
  assert.equal((await store.listDocuments([mine], refs)).files.length, 3, "different scopes remain separate documents");
  assert.equal(
    (await store.listOwnedByScopes([mine])).files.length,
    3,
    "raw artifact listing keeps the per-turn ledger",
  );
  assert.deepEqual(
    (await store.resolveByOwnerPaths([shared, hidden])).map((f) => f.id).sort(),
    ["hidden", "shared"],
    "exact handle lookups do not collapse",
  );
  assert.ok(await store.open("owned-copy"), "original artifact links keep working");
  await store.setEnabled("shared", false);
  assert.deepEqual(
    (await store.listDocuments([], refs, { includeDisabled: true })).files.map((f) => f.id),
    ["second"],
    "a shared grant does not expose a disabled artifact",
  );

  const firstName = (await put("first-name", "renamed", 20, { name: "original.txt", ownerScopeId: teammate })).artifact;
  const searchedName = (await put("searched-name", "renamed", 21, { name: "100%_Report.txt", ownerScopeId: teammate }))
    .artifact;
  const named = [firstName, searchedName];
  assert.deepEqual(
    (await store.listDocuments([], named, { nameQuery: "%_REPORT" })).files.map((f) => f.id),
    ["searched-name"],
    "name filtering precedes grouping and applies to shared documents too",
  );
  const scoped = await store.listDocuments([mine], refs, { createdInScope: elsewhere, limit: 1 });
  assert.deepEqual(
    scoped.files.map((f) => f.id),
    ["other-scope"],
  );
  assert.equal(scoped.nextCursor, undefined);
}
