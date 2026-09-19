import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { abortS3MultipartUpload, bodyToReadable, s3Client } from "../src/persistence/s3.ts";
import { createS3SnapshotStore } from "../src/sandbox/home-snapshot.ts";
import { withOperationSignal } from "../src/util/async.ts";

for (const source of ["operation", "request"]) {
  test(`S3 requests honor ${source} cancellation while both signals are active`, async () => {
    const operation = new AbortController();
    const request = new AbortController();
    const entered = Promise.withResolvers<void>();
    const client = s3Client(undefined, {
      async send(_command, options) {
        assert.ok(options?.abortSignal);
        entered.resolve();
        return new Promise((_, reject) => {
          options.abortSignal!.addEventListener("abort", () => reject(options.abortSignal!.reason), { once: true });
        });
      },
    });
    const sent = withOperationSignal(operation.signal, () => client.send({}, { abortSignal: request.signal }));
    const rejected = assert.rejects(sent, { name: "AbortError" });
    await entered.promise;
    (source === "operation" ? operation : request).abort();
    await rejected;
  });
}

test("S3 refuses a later command after operation cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = s3Client(undefined, {
    async send() {
      calls++;
      controller.abort();
      return {};
    },
  });
  await withOperationSignal(controller.signal, async () => {
    await assert.rejects(client.send({}), { name: "AbortError" });
    await assert.rejects(client.send({}), { name: "AbortError" });
  });
  assert.equal(calls, 1);
});

for (const kind of ["node", "web"]) {
  test(`S3 ${kind} response bodies stop when their operation is cancelled`, async () => {
    const controller = new AbortController();
    const body = kind === "node" ? new Readable({ read() {} }) : new ReadableStream();
    const stream = withOperationSignal(controller.signal, () => bodyToReadable(body));
    const consuming = stream.toArray();
    const rejected = assert.rejects(consuming, { name: "AbortError" });
    controller.abort();
    await rejected;
    assert.equal(stream.destroyed, true);
  });
}

test("S3 returned response bodies retain cancellation after the request resolves", async () => {
  const controller = new AbortController();
  const body = new Readable({ read() {} });
  const client = s3Client(undefined, { send: async () => ({ Body: body }) });
  await withOperationSignal(controller.signal, () => client.send({}));
  const consuming = body.toArray();
  const rejected = assert.rejects(consuming, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(body.destroyed, true);
});

test("S3 closes an unread response when cancellation wins while headers arrive", async () => {
  const controller = new AbortController();
  const body = new Readable({ read() {} });
  const client = s3Client(undefined, {
    async send() {
      controller.abort();
      return { Body: body };
    },
  });
  await assert.rejects(
    withOperationSignal(controller.signal, () => client.send({})),
    { name: "AbortError" },
  );
  assert.equal(body.destroyed, true);
});

test("S3 multipart cleanup joins a fresh bounded request without reviving its cancelled operation", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cleanupSignal: AbortSignal | undefined;
  let calls = 0;
  const client = s3Client(undefined, {
    async send(command, options) {
      calls++;
      assert.ok(command instanceof AbortMultipartUploadCommand);
      cleanupSignal = options?.abortSignal;
      assert.ok(cleanupSignal);
      assert.notEqual(cleanupSignal, controller.signal);
      assert.equal(cleanupSignal.aborted, false);
      entered.resolve();
      await release.promise;
      return {};
    },
  });
  await withOperationSignal(controller.signal, async () => {
    controller.abort();
    let finished = false;
    const cleaning = abortS3MultipartUpload(client, { Bucket: "test", Key: "home.tar", UploadId: "upload" }).then(
      () => {
        finished = true;
      },
    );
    await entered.promise;
    assert.equal(finished, false);
    release.resolve();
    await cleaning;
    assert.equal(cleanupSignal?.aborted, true);
    await assert.rejects(client.send({}), { name: "AbortError" });
  });
  assert.equal(calls, 1);
});

for (const fails of [false, true]) {
  test(`S3 compensates a multipart creation returned after cancellation when cleanup ${fails ? "fails" : "succeeds"}`, async (t) => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: string[] = [];
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
    let cleanupSignal: AbortSignal | undefined;
    let finished = false;
    const client = s3Client(undefined, {
      async send(command, options) {
        calls.push((command as object).constructor.name);
        if (command instanceof CreateMultipartUploadCommand) {
          controller.abort(new Error("original operation cancelled"));
          return { UploadId: "created-before-cancel" };
        }
        assert.ok(command instanceof AbortMultipartUploadCommand);
        assert.deepEqual(command.input, { Bucket: "test", Key: "home.tar", UploadId: "created-before-cancel" });
        cleanupSignal = options?.abortSignal;
        assert.ok(cleanupSignal);
        assert.notEqual(cleanupSignal, controller.signal);
        assert.equal(cleanupSignal.aborted, false);
        entered.resolve();
        await release.promise;
        if (fails) throw new Error("abort denied");
        return {};
      },
    });
    const creating = withOperationSignal(controller.signal, () =>
      client.send(new CreateMultipartUploadCommand({ Bucket: "test", Key: "home.tar" })),
    );
    const rejected = assert
      .rejects(creating, (error) => error === controller.signal.reason)
      .finally(() => {
        finished = true;
      });
    try {
      await entered.promise;
      assert.equal(finished, false);
    } finally {
      release.resolve();
      await rejected;
    }
    assert.equal(cleanupSignal?.aborted, true);
    assert.deepEqual(calls, ["CreateMultipartUploadCommand", "AbortMultipartUploadCommand"]);
    assert.equal(warnings.length, fails ? 1 : 0);
    if (fails) assert.match(warnings.flat().join(" "), /s3: abort upload after cancelled creation.*abort denied/);
  });
}

for (const operation of ["upload", "copy"]) {
  test(`snapshot ${operation} aborts its multipart upload after operation cancellation`, async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const store = createS3SnapshotStore({
      bucket: "test",
      prefix: "snapshots",
      s3: {
        async send(command, options) {
          calls.push((command as object).constructor.name);
          if (command instanceof HeadObjectCommand) return { ContentLength: 6 * 1024 ** 3 };
          if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
          if (command instanceof UploadPartCopyCommand) {
            controller.abort();
            options?.abortSignal?.throwIfAborted();
          }
          assert.ok(command instanceof AbortMultipartUploadCommand);
          assert.equal(command.input.UploadId, "upload");
          assert.equal(options?.abortSignal?.aborted, false);
          return {};
        },
      },
    });
    await withOperationSignal(controller.signal, async () => {
      if (operation === "upload") {
        const upload = await store.createUpload("scope");
        controller.abort();
        await upload.abort();
        await assert.rejects(upload.complete(), { name: "AbortError" });
      } else {
        await assert.rejects(store.adoptFromS3!("scope", { bucket: "source", key: "home.tar" }), {
          name: "AbortError",
        });
      }
    });
    assert.ok(calls.includes("AbortMultipartUploadCommand"));
    assert.ok(!calls.includes("CompleteMultipartUploadCommand"));
    assert.ok(!calls.includes("PutObjectCommand"));
  });
}
