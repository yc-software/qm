import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";
import { S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import {
  createRenderAppStorage,
  renderAppStoragePolicy,
  type StoredRenderAppStorage,
} from "../src/deploy/render-app-storage.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createFakeRenderApi, type FakeRenderApiCall } from "./support/fake-render.ts";

type StorageOptions = Parameters<typeof createRenderAppStorage>[0];

function fixture(handle: (call: FakeRenderApiCall) => unknown, extra: Partial<StorageOptions> = {}) {
  const store = createMemoryMap<StoredRenderAppStorage>();
  const api = createFakeRenderApi((call) => {
    if (call.path === "/services/srv-minio" && call.method === "GET")
      return { ownerId: "tea-test", environmentId: "env-test", type: "web_service" };
    return handle(call);
  });
  const opts: StorageOptions = {
    apiKey: "key",
    workspaceId: "tea-test",
    environmentId: "env-test",
    minioServiceId: "srv-minio",
    endpoint: "http://localhost:9000",
    bucket: "qm-storage",
    store,
    keyMaterial: "test-key",
    api,
    ...extra,
  };
  return { store, api, opts, storage: createRenderAppStorage(opts), restart: () => createRenderAppStorage(opts) };
}

test("Render storage jobs retain command failures without logging credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qm-render-storage-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "timeout"),
    `#!/bin/sh
case "$*" in
  *"alias set"*) read -r user; read -r password; printf '%s' "$password" ;;
  *"admin user add"*) read -r password; printf '%s' "$password" ;;
  *"admin policy create"*) printf 'AccessDenied\\n' >&2; exit 42 ;;
esac
exit 0
`,
    { mode: 0o700 },
  );
  let output = { stdout: "", stderr: "", code: 0 };
  const f = fixture(async ({ method, body }) => {
    if (method !== "POST") return { status: "failed" };
    const [shell, ...args] = (body as { startCommand: string }).startCommand.split(" ");
    await promisify(execFile)(shell!, args, {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        MINIO_ROOT_USER: "test-root",
        MINIO_ROOT_PASSWORD: "test-root-password",
      },
    }).catch((error: { stdout: string; stderr: string; code: number }) => {
      output = error;
    });
    return { id: "job-storage-error" };
  });
  await assert.rejects(f.storage.ensure(randomUUID()), /job-storage-error failed/);
  assert.equal(output.code, 42);
  assert.match(output.stderr, /AccessDenied/);
  assert.match(output.stderr, /MinIO admin policy create .* failed \(exit 42\)/);
  assert.equal(output.stdout, "");
  assert.equal(output.stderr.includes("test-root-password"), false);
});

test("Render storage policies constrain listing and writes to one app prefix", () => {
  const prefix = `app-data/${randomUUID()}/`;
  const policy = renderAppStoragePolicy("qm-storage", prefix);
  const statement = (action: string) => policy.Statement.find((item) => item.Action.includes(action))!;
  assert.deepEqual(statement("s3:ListBucket").Condition, { StringLike: { "s3:prefix": [`${prefix}*`] } });
  assert.deepEqual(statement("s3:PutObject").Resource, [`arn:aws:s3:::qm-storage/${prefix}*`]);
  for (const unsafe of ["../", "*", "app-data/*/", "app-data/?/", ""])
    assert.throws(() => renderAppStoragePolicy("qm-storage", unsafe));
});

test("Render app storage keeps one set of credentials per app and only changes its MinIO service", async () => {
  let jobs = 0;
  const f = fixture(
    ({ method, path }) => {
      if (path === "/services/srv-minio/jobs" && method === "POST") return { id: `job-${++jobs}`, status: "pending" };
      if (path.startsWith("/services/srv-minio/jobs/job-") && method === "GET") return { status: "succeeded" };
      throw new Error(`Unexpected ${method} ${path}`);
    },
    { endpoint: "http://qm-minio:9000", keyMaterial: "encryption-key" },
  );
  const id = randomUUID();
  const first = await f.storage.ensure(id);
  assert.equal(first.S3_PREFIX, `app-data/${id}/`);
  assert.equal(first.AWS_REQUEST_CHECKSUM_CALCULATION, "WHEN_REQUIRED");
  assert.equal(JSON.stringify(await f.store.get(id)).includes(first.AWS_SECRET_ACCESS_KEY!), false);
  assert.deepEqual(await f.restart().ensure(id), first);
  assert.equal(jobs, 1);
  assert.equal((await f.store.get(id))!.enabled, true);
  assert.deepEqual(await f.restart().ensure(id, true), first);
  assert.equal(jobs, 2);
  assert.equal((await f.store.get(id))!.enabled, true);
  assert.ok(f.api.calls.every((call) => call.path.startsWith("/services/srv-minio")));
  const another = await f.storage.ensure(randomUUID());
  assert.notEqual(another.AWS_ACCESS_KEY_ID, first.AWS_ACCESS_KEY_ID);
  assert.notEqual(another.S3_PREFIX, first.S3_PREFIX);
});

test("Render app storage settings send S3 stream bytes without checksum trailers", async () => {
  const f = fixture(({ method }) => (method === "POST" ? { id: "job-test" } : { status: "succeeded" }), {
    endpoint: "https://minio.example.test",
  });
  const env = await f.storage.ensure(randomUUID());
  const directory = await mkdtemp(join(tmpdir(), "qm-render-s3-"));
  const file = join(directory, "part");
  const input = Buffer.from("Render streamed object bytes\n".repeat(1024));
  const previous = process.env.AWS_REQUEST_CHECKSUM_CALCULATION;
  try {
    await writeFile(file, input);
    const requests: Array<{ headers: Record<string, string>; bytes: Buffer }> = [];
    for (const checksum of ["WHEN_SUPPORTED", env.AWS_REQUEST_CHECKSUM_CALCULATION!]) {
      process.env.AWS_REQUEST_CHECKSUM_CALCULATION = checksum;
      const client = new S3Client({
        endpoint: env.AWS_ENDPOINT_URL_S3,
        region: env.AWS_REGION,
        forcePathStyle: true,
        credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
        maxAttempts: 1,
        requestHandler: {
          async handle(request: { headers: Record<string, string>; body: AsyncIterable<Uint8Array> }) {
            const chunks: Buffer[] = [];
            for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
            requests.push({ headers: request.headers, bytes: Buffer.concat(chunks) });
            return { response: { statusCode: 200, headers: { etag: '"part"' }, body: Readable.from([]) } };
          },
        },
      });
      const body = createReadStream(file);
      try {
        await client.send(
          new UploadPartCommand({
            Bucket: env.S3_BUCKET,
            Key: env.S3_PREFIX + "part",
            UploadId: "test-upload",
            PartNumber: 1,
            Body: body,
            ContentLength: input.length,
          }),
        );
      } finally {
        body.destroy();
        client.destroy();
      }
    }
    const [defaultRequest, renderRequest] = requests;
    assert.equal(defaultRequest!.headers["content-encoding"], "aws-chunked");
    assert.equal(defaultRequest!.headers["x-amz-trailer"], "x-amz-checksum-crc32");
    assert.notDeepEqual(defaultRequest!.bytes, input);
    assert.equal(renderRequest!.headers["content-length"], String(input.length));
    assert.equal(renderRequest!.headers["content-encoding"], undefined);
    assert.equal(renderRequest!.headers["transfer-encoding"], undefined);
    assert.equal(renderRequest!.headers["x-amz-trailer"], undefined);
    assert.deepEqual(renderRequest!.bytes, input);
  } finally {
    if (previous === undefined) delete process.env.AWS_REQUEST_CHECKSUM_CALCULATION;
    else process.env.AWS_REQUEST_CHECKSUM_CALCULATION = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("A failed Render storage job leaves the account disabled so a retry repairs it", async () => {
  let outcome = "failed";
  let jobs = 0;
  const f = fixture(({ method }) => (method === "POST" ? { id: `job-${++jobs}` } : { status: outcome }));
  const id = randomUUID();
  await assert.rejects(f.storage.ensure(id), /job-1 failed/);
  assert.equal((await f.store.get(id))!.enabled, false);
  outcome = "succeeded";
  await f.storage.ensure(id);
  assert.equal(jobs, 2);
  assert.equal((await f.store.get(id))!.enabled, true);
  await f.storage.ensure(id);
  assert.equal(jobs, 2);
});

test("A canceled Render storage job names its status", async () => {
  const f = fixture(({ method }) => (method === "POST" ? { id: "job-1" } : { status: "canceled" }));
  await assert.rejects(f.storage.ensure(randomUUID()), /job-1 canceled/);
});
