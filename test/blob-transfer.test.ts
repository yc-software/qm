import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import {
  BlobHashMismatchError,
  BlobTooLargeError,
  collectBlob,
  createLocalBlobTransferStore,
  createMemoryBlobTransferStore,
  createS3BlobTransferStore,
  S3_PART_BYTES,
  type BlobTransferStore,
} from "../src/persistence/blob-transfer.ts";

function fakeS3(now: () => number = () => Date.now(), hooks: { onAbort?: () => void } = {}) {
  const objects = new Map<string, { body: Buffer; lastModified: Date }>();
  const uploads = new Map<string, Buffer[]>();
  const partSizes: number[] = [];
  const aborted: string[] = [];
  let lifecycle: { Rules: Array<Record<string, unknown>> } | null = null;
  let nextUploadId = 1;
  const client = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof CreateMultipartUploadCommand) {
        const UploadId = `up-${nextUploadId++}`;
        uploads.set(UploadId, []);
        return { UploadId };
      }
      if (command instanceof UploadPartCommand) {
        const input = command.input;
        const body = input.Body as Buffer;
        partSizes.push(body.length);
        const parts = uploads.get(input.UploadId as string);
        if (!parts) throw new Error("no such upload");
        parts[(input.PartNumber as number) - 1] = body;
        return { ETag: `etag-${input.PartNumber}` };
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        const input = command.input;
        const parts = uploads.get(input.UploadId as string);
        if (!parts) throw new Error("no such upload");
        objects.set(input.Key as string, { body: Buffer.concat(parts), lastModified: new Date(now()) });
        uploads.delete(input.UploadId as string);
        return {};
      }
      if (command instanceof AbortMultipartUploadCommand) {
        hooks.onAbort?.();
        aborted.push(command.input.UploadId as string);
        uploads.delete(command.input.UploadId as string);
        return {};
      }
      if (command instanceof PutObjectCommand) {
        const input = command.input;
        objects.set(input.Key as string, { body: input.Body as Buffer, lastModified: new Date(now()) });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const hit = objects.get(command.input.Key as string);
        if (!hit) {
          const err = new Error("NoSuchKey") as Error & { name: string };
          err.name = "NoSuchKey";
          throw err;
        }
        return { Body: Readable.from(hit.body), ContentLength: hit.body.length };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key as string);
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? "";
        const contents = [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, v]) => ({ Key: key, LastModified: v.lastModified }));
        return { Contents: contents, IsTruncated: false };
      }
      if (command instanceof GetBucketLifecycleConfigurationCommand) {
        if (lifecycle === null) {
          const err = new Error("NoSuchLifecycleConfiguration") as Error & { name: string };
          err.name = "NoSuchLifecycleConfiguration";
          throw err;
        }
        return lifecycle;
      }
      if (command instanceof PutBucketLifecycleConfigurationCommand) {
        lifecycle = command.input.LifecycleConfiguration as unknown as { Rules: Array<Record<string, unknown>> };
        return {};
      }
      throw new Error("unexpected command");
    },
  };
  return {
    objects,
    client,
    partSizes,
    aborted,
    liveUploads: uploads,
    getLifecycle: () => lifecycle,
    seedLifecycle: (r: { Rules: Array<Record<string, unknown>> }) => {
      lifecycle = r;
    },
  };
}

const localDir = (): string => mkdtempSync(join(tmpdir(), "blob-xfer-"));
const stores = (): Array<[string, BlobTransferStore, string | null]> => {
  const dir = localDir();
  return [
    ["local-fs", createLocalBlobTransferStore(dir), dir],
    ["memory", createMemoryBlobTransferStore(), null],
    ["s3", createS3BlobTransferStore({ bucket: "b", _client: fakeS3().client }), null],
  ];
};

for (const [label, store, _dir] of stores()) {
  test(`${label}: put a buffer, open it, and read the bytes back`, async () => {
    const data = Buffer.from("hello, world");
    const info = await store.put(data);
    assert.equal(info.sizeBytes, data.length);
    assert.equal(info.sha256, createHash("sha256").update(data).digest("hex"));
    const opened = await store.open(info.blobId);
    assert.ok(opened);
    assert.equal(opened.sizeBytes, data.length);
    assert.equal((await collectBlob(opened.stream)).toString("utf8"), "hello, world");
  });

  test(`${label}: put a STREAM (multi-chunk) reassembles in order`, async () => {
    const chunks = ["alpha", "-", "beta", "-", "gamma"].map((s) => Buffer.from(s));
    const info = await store.put(Readable.from(chunks));
    const opened = await store.open(info.blobId);
    assert.equal((await collectBlob(opened!.stream)).toString("utf8"), "alpha-beta-gamma");
  });

  test(`${label}: maxBytes trips BlobTooLargeError mid-stream`, async () => {
    await assert.rejects(
      () => store.put(Buffer.alloc(1000), { maxBytes: 500 }),
      (e) => e instanceof BlobTooLargeError,
    );
  });

  test(`${label}: a wrong expectedSha256 trips BlobHashMismatchError`, async () => {
    await assert.rejects(
      () => store.put(Buffer.from("data"), { expectedSha256: "0".repeat(64) }),
      (e) => e instanceof BlobHashMismatchError,
    );
  });

  test(`${label}: a correct expectedSha256 is accepted`, async () => {
    const data = Buffer.from("verify me");
    const sha = createHash("sha256").update(data).digest("hex");
    const info = await store.put(data, { expectedSha256: sha });
    assert.equal(info.sha256, sha);
  });

  test(`${label}: open returns null for an unknown or malformed id`, async () => {
    assert.equal(await store.open("ffffffffffffffffffffffffffffffff"), null);
    assert.equal(await store.open("not-a-valid-id"), null);
  });

  test(`${label}: delete removes a staged blob`, async () => {
    const { blobId } = await store.put(Buffer.from("ephemeral"));
    assert.ok(await store.open(blobId));
    await store.delete(blobId);
    assert.equal(await store.open(blobId), null);
  });

  test(`${label}: sweep(0) reclaims staged blobs`, async () => {
    await store.put(Buffer.from("a"));
    await store.put(Buffer.from("b"));
    const removed = await store.sweep(0);
    assert.ok(removed >= 2);
  });
}

test("local-fs: a failed put (over cap) leaves no orphan blob file behind", async () => {
  const dir = localDir();
  const store = createLocalBlobTransferStore(dir);
  await assert.rejects(
    () => store.put(Buffer.alloc(1000), { maxBytes: 100 }),
    (e) => e instanceof BlobTooLargeError,
  );
  const leftover = readdirSync(dir);
  assert.deepEqual(leftover, []);
});

test("local-fs: a finalized blob is named by its id (no .part suffix lingering)", async () => {
  const dir = localDir();
  const store = createLocalBlobTransferStore(dir);
  const { blobId } = await store.put(Buffer.from("done"));
  const names = readdirSync(dir);
  assert.deepEqual(names, [blobId]);
});

test("s3: blobs are keyed under '<prefix>transfer/<id>' (snapshot-bucket coexistence)", async () => {
  const { objects, client } = fakeS3();
  const store = createS3BlobTransferStore({ bucket: "b", prefix: "core/", _client: client });
  const { blobId } = await store.put(Buffer.from("payload"));
  assert.deepEqual([...objects.keys()], [`core/transfer/${blobId}`]);
});

test("s3: open returns null for a missing object (NoSuchKey is not an error)", async () => {
  const store = createS3BlobTransferStore({ bucket: "b", _client: fakeS3().client });
  assert.equal(await store.open("ffffffffffffffffffffffffffffffff"), null);
});

test("s3: open THROWS on a transient error (does NOT masquerade a 5xx/throttle as absent)", async () => {
  const boom = new Error("ServiceUnavailable") as Error & { $metadata: { httpStatusCode: number } };
  boom.$metadata = { httpStatusCode: 503 };
  const store = createS3BlobTransferStore({ bucket: "b", _client: { send: async () => Promise.reject(boom) } });
  await assert.rejects(() => store.open("ffffffffffffffffffffffffffffffff"), /ServiceUnavailable/);
});

test("local-fs: open THROWS on a non-ENOENT stat error (ENOTDIR), not a false 404", async () => {
  const dir = localDir();
  const fileAsDir = join(dir, "not-a-dir");
  writeFileSync(fileAsDir, "i am a file");
  const broken = createLocalBlobTransferStore(fileAsDir);
  await assert.rejects(
    () => broken.open("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    (e: NodeJS.ErrnoException) => e.code === "ENOTDIR",
  );
  const ok = createLocalBlobTransferStore(dir);
  assert.equal(await ok.open("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), null);
});

test("s3: a malformed blobId never touches S3 (anti-traversal guard)", async () => {
  let sends = 0;
  const { client } = fakeS3();
  const guarded = { send: (c: unknown) => (sends++, client.send(c)) };
  const store = createS3BlobTransferStore({ bucket: "b", _client: guarded });
  assert.equal(await store.open("../etc/passwd"), null);
  await store.delete("../etc/passwd");
  assert.equal(sends, 0);
});

test("s3: sweep deletes only blobs older than the cutoff, by LastModified", async () => {
  const realNow = Date.now();
  let clock = realNow - 60_000;
  const { objects, client } = fakeS3(() => clock);
  const store = createS3BlobTransferStore({ bucket: "b", _client: client });
  const old = await store.put(Buffer.from("stale"));
  clock = realNow;
  const fresh = await store.put(Buffer.from("fresh"));
  const removed = await store.sweep(5_000);
  assert.equal(removed, 1);
  assert.equal(await store.open(old.blobId), null);
  assert.ok(await store.open(fresh.blobId));
  assert.deepEqual([...objects.keys()], [`transfer/${fresh.blobId}`]);
});

test("s3 ensureExpiry installs a transfer-prefix lifecycle rule on a bucket with no existing config", async () => {
  const fake = fakeS3();
  const store = createS3BlobTransferStore({ bucket: "b", _client: fake.client });
  const installed = await store.ensureExpiry!(1);
  assert.equal(installed, true);
  const cfg = fake.getLifecycle();
  assert.ok(cfg, "a lifecycle config was PUT");
  const ours = cfg!.Rules.find((r) => r.ID === "qm-transfer-expiry") as
    { Filter?: unknown; Expiration?: unknown; Status?: unknown } | undefined;
  assert.ok(ours, "our rule is present");
  assert.deepEqual(ours!.Filter, { Prefix: "transfer/" }, "scoped to the disposable transfer/ prefix");
  assert.deepEqual(ours!.Expiration, { Days: 1 });
  assert.equal(ours!.Status, "Enabled");
});

test("s3 ensureExpiry preserves unrelated rules and replaces only its own (idempotent)", async () => {
  const fake = fakeS3();
  fake.seedLifecycle({
    Rules: [
      { ID: "someone-elses-rule", Status: "Enabled" },
      { ID: "qm-transfer-expiry", Status: "Enabled", Expiration: { Days: 9 } },
    ],
  });
  const store = createS3BlobTransferStore({ bucket: "b", _client: fake.client });
  await store.ensureExpiry!(2);
  const rules = fake.getLifecycle()!.Rules;
  assert.ok(
    rules.some((r) => r.ID === "someone-elses-rule"),
    "an unrelated lifecycle rule is never clobbered",
  );
  const ours = rules.filter((r) => r.ID === "qm-transfer-expiry");
  assert.equal(ours.length, 1, "exactly one copy of our rule (replaced, not duplicated)");
  assert.deepEqual((ours[0] as { Expiration?: unknown }).Expiration, { Days: 2 }, "our rule updated to the new age");
});

test("local + memory stores do not implement ensureExpiry (they stay on the in-process sweep)", () => {
  assert.equal(createLocalBlobTransferStore(localDir()).ensureExpiry, undefined);
  assert.equal(createMemoryBlobTransferStore().ensureExpiry, undefined);
});

test("s3: parts are carved to exactly one part regardless of how the source chunks it", async () => {
  const f = fakeS3();
  const store = createS3BlobTransferStore({ bucket: "b", _client: f.client });
  const ragged = [
    Buffer.alloc(S3_PART_BYTES - 1, 0x61),
    Buffer.alloc(S3_PART_BYTES - 1, 0x62),
    Buffer.alloc(3, 0x63),
    Buffer.alloc(2 * S3_PART_BYTES, 0x64),
    Buffer.from("tail"),
  ];
  const body = Buffer.concat(ragged);
  const info = await store.put(Readable.from(ragged));

  assert.equal(info.sizeBytes, body.length);
  assert.equal(info.sha256, createHash("sha256").update(body).digest("hex"));
  const nonFinal = f.partSizes.slice(0, -1);
  assert.ok(nonFinal.length > 0, "this body must span several parts");
  assert.deepEqual(
    [...new Set(nonFinal)],
    [S3_PART_BYTES],
    "every non-final part is EXACTLY one part — the memory bound is on the part, not the trigger",
  );
  assert.ok(f.partSizes.at(-1)! <= S3_PART_BYTES, "the remainder is the last part");
  const opened = await store.open(info.blobId);
  assert.ok(Buffer.from(await collectBlob(opened!.stream)).equals(body), "reassembles in order");
});

test("s3: a body of EXACTLY one part stays a single PutObject (no multipart upload opened)", async () => {
  const f = fakeS3();
  const store = createS3BlobTransferStore({ bucket: "b", _client: f.client });
  const info = await store.put(Buffer.alloc(S3_PART_BYTES, 0x65));
  assert.equal(f.partSizes.length, 0, "exactly one part is still one part — no Create/Upload/Complete");
  const opened = await store.open(info.blobId);
  assert.equal((await collectBlob(opened!.stream)).length, S3_PART_BYTES);
});

test("s3: a body that fits in one part never opens a multipart upload", async () => {
  const f = fakeS3();
  const store = createS3BlobTransferStore({ bucket: "b", _client: f.client });
  await store.put(Buffer.from("small"));
  assert.equal(f.partSizes.length, 0, "single PutObject, exactly as before");
});

test("s3: maxBytes tripped mid-multipart aborts the upload instead of stranding parts", async () => {
  const f = fakeS3();
  const store = createS3BlobTransferStore({ bucket: "b", _client: f.client });
  const chunk = Buffer.alloc(S3_PART_BYTES, 0x62);
  await assert.rejects(
    () => store.put(Readable.from([chunk, chunk, chunk]), { maxBytes: 2 * S3_PART_BYTES + 10 }),
    (e) => e instanceof BlobTooLargeError,
  );
  assert.equal(f.aborted.length, 1, "the started multipart upload was aborted");
  assert.equal(f.liveUploads.size, 0, "no parts left billing in the bucket");
  assert.equal(f.objects.size, 0, "and no object was completed");
});

test("s3: a wrong expectedSha256 on a multipart body deletes the object it already wrote", async () => {
  const f = fakeS3();
  const store = createS3BlobTransferStore({ bucket: "b", _client: f.client });
  const chunk = Buffer.alloc(S3_PART_BYTES, 0x63);
  await assert.rejects(
    () => store.put(Readable.from([chunk, Buffer.from("x")]), { expectedSha256: "0".repeat(64) }),
    (e) => e instanceof BlobHashMismatchError,
  );
  assert.equal(f.objects.size, 0, "the completed object is removed — a mismatch leaves nothing behind");
});

test("s3: a failed abort is reported, never silently swallowed (parts would bill forever)", async () => {
  const f = fakeS3(() => Date.now(), {
    onAbort: () => {
      throw new Error("AccessDenied: s3:AbortMultipartUpload");
    },
  });
  const store = createS3BlobTransferStore({ bucket: "b", _client: f.client });
  const chunk = Buffer.alloc(S3_PART_BYTES, 0x64);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    await assert.rejects(
      () => store.put(Readable.from([chunk, chunk, chunk]), { maxBytes: 2 * S3_PART_BYTES + 10 }),
      (e) => e instanceof BlobTooLargeError,
      "the original failure still surfaces, not the abort failure",
    );
  } finally {
    console.warn = realWarn;
  }
  assert.ok(
    warnings.some((w) => w.includes("leaked S3 multipart parts")),
    "an un-abortable upload names the leak so an operator can find it",
  );
});

test("s3: ensureExpiry also reaps incomplete multipart uploads (invisible to ListObjects)", async () => {
  const f = fakeS3();
  const store = createS3BlobTransferStore({ bucket: "b", _client: f.client });
  await store.ensureExpiry!(3);
  const rule = f.getLifecycle()!.Rules.find((r) => r.ID === "qm-transfer-expiry")!;
  assert.deepEqual(rule.Expiration, { Days: 3 });
  assert.deepEqual(
    rule.AbortIncompleteMultipartUpload,
    { DaysAfterInitiation: 3 },
    "orphaned parts are not objects; only this rule can reap them",
  );
});
