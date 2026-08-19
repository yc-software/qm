import assert from "node:assert/strict";
import test from "node:test";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { HttpRequest } from "@smithy/types";
import { s3Client } from "../src/persistence/s3.ts";

test("s3Client enables path-style addressing for S3-compatible storage", () => {
  const defaultClient = s3Client({ region: "auto" }) as S3Client;
  const pathStyleClient = s3Client({ region: "auto", forcePathStyle: true }) as S3Client;
  try {
    assert.equal(defaultClient.config.forcePathStyle, false);
    assert.equal(pathStyleClient.config.forcePathStyle, true);
  } finally {
    defaultClient.destroy();
    pathStyleClient.destroy();
  }
});

async function putRequestUrl(forcePathStyle: boolean): Promise<string> {
  let requestUrl = "";
  const client = s3Client({
    region: "us-east-1",
    endpoint: "https://minio.example.test",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle,
    requestHandler: {
      async handle(request: HttpRequest) {
        requestUrl = `${request.protocol}//${request.hostname}${request.path}`;
        return { response: { statusCode: 200, headers: {} } };
      },
    },
  }) as S3Client;
  try {
    await client.send(new PutObjectCommand({ Bucket: "qm-data", Key: "files/test", Body: "test" }));
    return requestUrl;
  } finally {
    client.destroy();
  }
}

test("s3Client sends path-style requests to S3-compatible endpoints", async () => {
  assert.equal(await putRequestUrl(false), "https://qm-data.minio.example.test/files/test");
  assert.equal(await putRequestUrl(true), "https://minio.example.test/qm-data/files/test");
});
