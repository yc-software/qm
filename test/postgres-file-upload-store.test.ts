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
      expiresAt: Date.now() - 1,
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
