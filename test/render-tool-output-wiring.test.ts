import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import * as toolOutput from "../src/sessions/tool-output.ts";
import { testConfig } from "./support/test-config.ts";

type ToolOutputOptions = Parameters<typeof toolOutput.createPostgresToolOutputStore>[0];
let bytesFor: ToolOutputOptions["bytesFor"] | undefined;

mock.module("../src/sessions/tool-output.ts", {
  namedExports: {
    ...toolOutput,
    createPostgresToolOutputStore: (options: ToolOutputOptions) => {
      bytesFor = options.bytesFor;
      return toolOutput.createPostgresToolOutputStore(options);
    },
  },
});

const { buildApp } = await import("../src/wiring.ts");

test("parked tool output uses the configured S3 endpoint and bucket path", async (t) => {
  const requests: Array<{ hostname: string; path: string }> = [];
  const send = S3Client.prototype.send;
  t.mock.method(S3Client.prototype, "send", function (this: S3Client, command: Parameters<S3Client["send"]>[0]) {
    this.config.credentials = async () => ({ accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" });
    this.middlewareStack.add(
      () => async (args) => {
        requests.push(args.request as { hostname: string; path: string });
        return { response: {}, output: { $metadata: {}, UploadId: "test-upload", ETag: "test-etag" } };
      },
      { name: "captureRequest", step: "finalizeRequest", override: true },
    );
    return Reflect.apply(send, this, [command]);
  });
  const config = testConfig({
    sandboxBackend: "local",
    snapshotStore: "s3",
    s3Bucket: "qm-storage",
    s3Region: "us-east-1",
    s3Endpoint: "http://minio.internal:9000",
  });
  const built = buildApp(config);
  try {
    assert.ok(bytesFor);
    const result = await bytesFor("tool-output/test/").put(Buffer.from("complete tool output"));
    assert.equal(result.sizeBytes, Buffer.byteLength("complete tool output"));
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.hostname, "minio.internal");
      assert.equal(request.path, `/qm-storage/tool-output/test/${result.blobKey}`);
    }
  } finally {
    await built.runtime.stop();
  }
});
