import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresFileUploadStore, MAX_ACTIVE_UPLOADS } from "../src/files/file-upload-store.ts";
import type { FileUpload } from "../src/files/file-upload-store.ts";
import { scopeId } from "../src/types.ts";

const url = process.env.DATABASE_URL;
test(
  "upload sessions survive recreation; quota and state transitions serialize across cores",
  { skip: !url },
  async () => {
    const actorId = `upload-test-${randomUUID()}`;
    const first = createPostgresFileUploadStore(url!);
    const second = createPostgresFileUploadStore(url!);
    const row = (): FileUpload => ({
      id: randomUUID().replaceAll("-", ""),
      actorId,
      scopeId: scopeId("personal", actorId),
      name: "file",
      mimetype: "text/plain",
      sizeBytes: 1,
      partSize: 64 * 1024 * 1024,
      checksums: ["hash"],
      uploadId: "provider-upload",
      state: "pending",
      expiresAt: 0,
      createdAt: Date.now(),
    });
    const uploads = Array.from({ length: MAX_ACTIVE_UPLOADS + 3 }, row);
    const results = await Promise.allSettled(uploads.map((r, i) => (i % 2 ? first : second).insert(r)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, MAX_ACTIVE_UPLOADS);
    const accepted = uploads[results.findIndex((r) => r.status === "fulfilled")]!;
    assert.deepEqual(await second.get(accepted.id), accepted);
    const claims = await Promise.all([
      first.transition(accepted.id, ["pending"], "completing"),
      second.transition(accepted.id, ["pending"], "aborting"),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.ok((await second.expired(Date.now())).some((r) => r.id === accepted.id));
    for (const item of uploads) await first.transition(item.id, ["pending", "completing", "aborting"], "aborted");
    await second.insert(row());
  },
);

test("expired upload batches rotate durably without starving later rows", { skip: !url }, async () => {
  const first = createPostgresFileUploadStore(url!);
  const second = createPostgresFileUploadStore(url!);
  const now = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < 103; i++) {
    const id = randomUUID().replaceAll("-", "");
    ids.push(id);
    await first.insert({
      id,
      actorId: `sweep-${id}`,
      scopeId: scopeId("personal", id),
      name: "file",
      mimetype: "text/plain",
      sizeBytes: 1,
      partSize: 64 * 1024 * 1024,
      checksums: ["hash"],
      uploadId: "upload",
      state: "completing",
      createdAt: now,
      expiresAt: i,
    });
  }
  const batch1 = await first.expired(now);
  const batch2 = await second.expired(now);
  assert.equal(batch1.length, 100);
  assert.ok(batch2.length >= 3);
  assert.ok(batch2.every((r) => !batch1.some((earlier) => earlier.id === r.id)));
  const seen = new Set([...batch1, ...batch2].map((r) => r.id));
  assert.ok(ids.every((id) => seen.has(id)));
  for (const id of ids) await first.transition(id, ["completing"], "failed");
  assert.ok(!(await second.expired(now + 120_000)).some((r) => ids.includes(r.id)));
});

test("terminal failed uploads release active quota", { skip: !url }, async () => {
  const store = createPostgresFileUploadStore(url!);
  const actorId = `failed-quota-${randomUUID()}`;
  const ids: string[] = [];
  for (let i = 0; i <= MAX_ACTIVE_UPLOADS; i++) {
    const id = randomUUID().replaceAll("-", "");
    ids.push(id);
    await store.insert({
      id,
      actorId,
      scopeId: scopeId("personal", actorId),
      name: "file",
      mimetype: "text/plain",
      sizeBytes: 1,
      partSize: 64 * 1024 * 1024,
      checksums: ["hash"],
      uploadId: "upload",
      state: "completing",
      createdAt: Date.now(),
      expiresAt: Date.now(),
    });
    await store.transition(id, ["completing"], "failed");
  }
  assert.equal((await store.get(ids.at(-1)!))!.state, "failed");
});
