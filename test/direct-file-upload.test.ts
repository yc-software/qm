import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  FileUploadError,
  createDirectFileUploads,
  multipartChecksum,
  FILE_UPLOAD_PART_SIZE,
} from "../src/files/direct-file-upload.ts";
import type { FileUpload, FileUploadStore } from "../src/files/file-upload-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { scopeId } from "../src/types.ts";

const checksum = (text: string) => createHash("sha256").update(text).digest("base64");
function fixture() {
  const rows = new Map<string, FileUpload>();
  const store: FileUploadStore = {
    async insert(row) {
      if (rows.has(row.id)) throw new Error("duplicate");
      rows.set(row.id, structuredClone(row));
    },
    async get(id) {
      const row = rows.get(id);
      return row ? structuredClone(row) : null;
    },
    async transition(id, from, to) {
      const row = rows.get(id);
      if (!row || !from.includes(row.state)) return false;
      row.state = to;
      return true;
    },
    async expired(now) {
      return [...rows.values()].filter(
        (r) => r.expiresAt <= now && r.state !== "complete" && r.state !== "aborted" && r.state !== "failed",
      );
    },
  };
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const calls: Array<{ name: string; input: Record<string, any> }> = [];
  let head: Record<string, unknown> | undefined;
  let parts: Array<Record<string, unknown>> = [];
  let time = 1_000;
  let loseCompleteResponse = false;
  const client = {
    async send(command: any) {
      calls.push({ name: command.constructor.name, input: command.input });
      switch (command.constructor.name) {
        case "CreateMultipartUploadCommand":
          return { UploadId: "s3-upload" };
        case "HeadObjectCommand":
          if (!head) throw Object.assign(new Error("missing"), { name: "NotFound" });
          return head;
        case "ListPartsCommand":
          return { Parts: parts };
        case "CompleteMultipartUploadCommand": {
          const row = [...rows.values()].find((r) => command.input.Key.endsWith(r.id))!;
          head = {
            ContentLength: row.sizeBytes,
            ChecksumSHA256: multipartChecksum(row.checksums),
            Metadata: { "qm-upload": row.id },
          };
          if (loseCompleteResponse) throw new Error("connection lost");
          return {};
        }
        case "ListMultipartUploadsCommand":
          return { Uploads: [] };
        case "AbortMultipartUploadCommand":
          return {};
        default:
          throw new Error(command.constructor.name);
      }
    },
  };
  const options = {
    bucket: "test-bucket",
    store,
    files,
    client,
    now: () => time,
    presign: async (command: any) => {
      calls.push({ name: "sign", input: command.input });
      return "https://example.invalid/signed";
    },
  };
  const service = createDirectFileUploads(options);
  const input = {
    actorId: "U1",
    scopeId: scopeId("personal", "U1"),
    name: "file.txt",
    mimetype: "text/plain",
    sizeBytes: 3,
    checksums: [checksum("abc")],
  };
  const uploadParts = (row: FileUpload) => {
    parts = row.checksums.map((c, i) => ({
      PartNumber: i + 1,
      ETag: `etag-${i}`,
      Size: Math.min(row.partSize, row.sizeBytes - i * row.partSize),
      ChecksumSHA256: c,
    }));
  };
  return {
    service,
    options,
    input,
    store,
    files,
    rows,
    calls,
    uploadParts,
    setHead: (h: Record<string, unknown>) => {
      head = h;
    },
    loseResponse: () => {
      loseCompleteResponse = true;
    },
    advance: () => {
      time += 25 * 60 * 60 * 1000;
    },
  };
}

test("signed parts bind the exact size, checksum, upload and number; unpublished parts are invisible", async () => {
  const f = fixture();
  const row = await f.service.begin(f.input);
  const signed = await f.service.sign(row.id, 1);
  assert.equal(signed.headers["content-length"], "3");
  assert.equal(signed.headers["x-amz-checksum-sha256"], checksum("abc"));
  assert.equal(f.calls.at(-1)!.input.UploadId, "s3-upload");
  assert.equal(f.calls.at(-1)!.input.PartNumber, 1);
  assert.equal(await f.files.get(row.id), null);
  await assert.rejects(f.service.sign(row.id, Number.NaN));
  await assert.rejects(f.service.sign(row.id, 0));
  await assert.rejects(f.service.sign(row.id, 2));
});

test("begin retries use one durable session and reject reuse with a different manifest", async () => {
  const f = fixture();
  const input = { ...f.input, requestId: "a".repeat(32) };
  const a = await f.service.begin(input);
  assert.deepEqual(await f.service.begin(input), a);
  assert.equal(f.calls.filter((c) => c.name === "CreateMultipartUploadCommand").length, 1);
  await assert.rejects(f.service.begin({ ...input, actorId: "U2" }), /already used/);
});

test("missing parts remain resumable and never publish", async () => {
  const f = fixture();
  const row = await f.service.begin(f.input);
  await assert.rejects(f.service.complete(row.id), /incomplete/);
  assert.equal((await f.store.get(row.id))!.state, "pending");
  await f.service.sign(row.id, 1);
  assert.equal(await f.files.get(row.id), null);
});

test("completion recovers a lost S3 response and is idempotent", async () => {
  const f = fixture();
  const row = await f.service.begin(f.input);
  f.uploadParts(row);
  f.loseResponse();
  const file = await f.service.complete(row.id);
  assert.equal(file.sizeBytes, 3);
  assert.equal(file.sha256, null);
  assert.equal(file.blobKey, `files/uploads/${row.id}`);
  assert.equal((await f.service.complete(row.id)).id, file.id);
  assert.equal(f.calls.filter((c) => c.name === "CompleteMultipartUploadCommand").length, 1);
  await assert.rejects(f.service.abort(row.id), /completion/);
});

test("a new core recovers after S3 completion but before metadata publication", async () => {
  const f = fixture();
  const row = await f.service.begin(f.input);
  f.uploadParts(row);
  const publish = f.files.publish.bind(f.files);
  f.files.publish = async () => {
    throw new Error("database disconnected");
  };
  await assert.rejects(f.service.complete(row.id), /database/);
  assert.equal((await f.store.get(row.id))!.state, "completing");
  f.files.publish = publish;
  const restarted = createDirectFileUploads(f.options);
  assert.equal((await restarted.complete(row.id)).id, row.id);
  assert.equal(f.calls.filter((c) => c.name === "CompleteMultipartUploadCommand").length, 1);
});

test("wrong completed-object integrity cannot produce a file", async () => {
  const f = fixture();
  const row = await f.service.begin(f.input);
  await f.store.transition(row.id, ["pending"], "completing");
  f.setHead({ ContentLength: 3, ChecksumSHA256: checksum("abc"), Metadata: { "qm-upload": row.id } });
  await assert.rejects(f.service.complete(row.id), /integrity/);
  assert.equal(await f.files.get(row.id), null);
});

test("expiry prevents signing and sweeper aborts without publishing", async () => {
  const f = fixture();
  const row = await f.service.begin(f.input);
  f.advance();
  await assert.rejects(f.service.sign(row.id, 1), /expired/);
  await assert.rejects(f.service.complete(row.id), /expired/);
  await f.service.sweep();
  assert.equal((await f.store.get(row.id))!.state, "aborted");
  assert.equal(await f.files.get(row.id), null);
  await f.service.abort(row.id);
});

test("abort wins the CAS before completion and prevents publication", async () => {
  const f = fixture();
  const row = await f.service.begin(f.input);
  f.uploadParts(row);
  const transition = f.store.transition.bind(f.store);
  f.store.transition = async (id, from, to) => {
    if (to === "completing") await transition(id, ["pending"], "aborted");
    return transition(id, from, to);
  };
  await assert.rejects(f.service.complete(row.id), /aborted/);
  assert.equal(await f.files.get(row.id), null);
  assert.equal(f.calls.filter((c) => c.name === "CompleteMultipartUploadCommand").length, 0);
});

test("empty files and multi-part manifests use correctly sized signed requests", async () => {
  const f = fixture();
  const empty = await f.service.begin({ ...f.input, sizeBytes: 0, checksums: [checksum("")] });
  assert.equal((await f.service.sign(empty.id, 1)).headers["content-length"], "0");
  f.uploadParts(empty);
  assert.equal((await f.service.complete(empty.id)).sizeBytes, 0);
  const next = await f.service.begin({
    ...f.input,
    sizeBytes: FILE_UPLOAD_PART_SIZE + 3,
    checksums: [checksum("first"), checksum("abc")],
  });
  assert.equal((await f.service.sign(next.id, 2)).headers["content-length"], "3");
});

test("invalid size, count and checksum rejected before allocating S3", async () => {
  const f = fixture();
  for (const update of [
    { sizeBytes: -1 },
    { sizeBytes: 101 * 1024 ** 3 },
    { checksums: [] },
    { checksums: ["not-base64"] },
    { checksums: ["Z".repeat(43) + "="] },
  ])
    await assert.rejects(f.service.begin({ ...f.input, ...update }));
  assert.equal(f.calls.length, 0);
});

test("an upload cannot reuse an unrelated artifact ID", async () => {
  const f = fixture();
  const id = "f".repeat(32);
  await f.files.put({
    id,
    ownerScopeId: scopeId("personal", "U2"),
    createdBy: "U2",
    name: "private",
    path: "private",
    mimetype: "text/plain",
    data: Buffer.from("private"),
    direction: "out",
  });
  await assert.rejects(f.service.begin({ ...f.input, requestId: id }), /already used/);
  assert.equal(f.calls.length, 0);
});

test("recovery cannot resurrect a deleted file when the upload state update failed", async () => {
  const f = fixture();
  const row = await f.service.begin(f.input);
  f.uploadParts(row);
  const transition = f.store.transition.bind(f.store);
  f.store.transition = async (id, from, to) => {
    if (to === "complete") throw new Error("database acknowledgement lost");
    return transition(id, from, to);
  };
  await assert.rejects(f.service.complete(row.id), /acknowledgement lost/);
  assert.ok(await f.files.get(row.id));
  assert.equal((await f.store.get(row.id))!.state, "completing");
  await f.files.delete(row.id);
  f.store.transition = transition;
  const restarted = createDirectFileUploads(f.options);
  await assert.rejects(
    restarted.complete(row.id),
    (error: unknown) => error instanceof FileUploadError && error.status === 410 && /deleted/.test(error.message),
  );
  assert.equal(await f.files.get(row.id, { includeDisabled: true }), null);
  assert.equal((await f.store.get(row.id))!.state, "complete");
  await assert.rejects(
    restarted.complete(row.id),
    (error: unknown) => error instanceof FileUploadError && error.status === 410 && /deleted/.test(error.message),
  );
});

test("missing multipart upload and object become terminal instead of retrying forever", async () => {
  const f = fixture();
  const row = await f.service.begin(f.input);
  await f.store.transition(row.id, ["pending"], "completing");
  const send = f.options.client.send;
  f.options.client.send = async (command: any) => {
    if (command.constructor.name === "ListPartsCommand")
      throw Object.assign(new Error("missing upload"), { name: "NoSuchUpload" });
    return send(command);
  };
  f.advance();
  await f.service.sweep();
  assert.equal((await f.store.get(row.id))!.state, "failed");
  assert.equal((await f.store.expired(Date.now())).length, 0);
  assert.equal(await f.files.get(row.id), null);
  await f.service.abort(row.id);
  await assert.rejects(f.service.complete(row.id), /no longer available/);
});
