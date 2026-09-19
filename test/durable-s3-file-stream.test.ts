import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { AbortMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { createS3DurableByteStore } from "../src/files/durable-byte-store.ts";
import { withOperationSignal } from "../src/util/async.ts";

test("S3 fallback streams large parts and aborts on transfer failure", async () => {
  let fail = false;
  const calls: string[] = [];
  const received: Buffer[] = [];
  const bytes = createS3DurableByteStore({
    bucket: "test",
    _client: {
      async send(command: any) {
        const name = command.constructor.name;
        calls.push(name);
        if (name === "CreateMultipartUploadCommand") return { UploadId: "id" };
        if (name === "UploadPartCommand") {
          assert.ok(command.input.Body instanceof Readable);
          if (fail) throw new Error("network down");
          for await (const chunk of command.input.Body) received.push(chunk);
          return { ETag: "etag" };
        }
        return {};
      },
    },
  });
  const input = Buffer.alloc(17 * 1024 * 1024, 0x31);
  const out = await bytes.put(Readable.from(input));
  assert.equal(out.sizeBytes, input.length);
  assert.equal(out.sha256, createHash("sha256").update(input).digest("hex"));
  assert.deepEqual(Buffer.concat(received), input);
  assert.equal(calls.filter((n) => n === "UploadPartCommand").length, 2);
  fail = true;
  await assert.rejects(bytes.put(Readable.from(Buffer.from("next"))), /network down/);
  assert.equal(calls.at(-1), "AbortMultipartUploadCommand");
});

test("S3 durable file cancellation aborts allocated multipart parts before returning", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  let cleanupSignal: AbortSignal | undefined;
  let finished = false;
  const bytes = createS3DurableByteStore({
    bucket: "test",
    _client: {
      async send(command, options) {
        calls.push((command as object).constructor.name);
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: "cancelled-upload" };
        if (command instanceof UploadPartCommand) {
          controller.abort();
          throw controller.signal.reason;
        }
        assert.ok(command instanceof AbortMultipartUploadCommand);
        assert.equal(command.input.UploadId, "cancelled-upload");
        cleanupSignal = options?.abortSignal;
        assert.ok(cleanupSignal);
        assert.notEqual(cleanupSignal, controller.signal);
        assert.equal(cleanupSignal.aborted, false);
        entered.resolve();
        await release.promise;
        return {};
      },
    },
  });
  const upload = withOperationSignal(controller.signal, () => bytes.put(Buffer.from("upload bytes")));
  const rejected = assert
    .rejects(upload, (error) => error === controller.signal.reason)
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
  assert.deepEqual(calls, ["CreateMultipartUploadCommand", "UploadPartCommand", "AbortMultipartUploadCommand"]);
});
