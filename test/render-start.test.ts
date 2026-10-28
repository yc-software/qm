import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { s3Client } from "../src/persistence/s3.ts";
import { awaitBucket } from "../src/render/start.ts";

async function withMinio(
  statuses: number[],
  run: (endpoint: string, requests: string[]) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(statuses[Math.min(requests.length - 1, statuses.length - 1)]!).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const previous = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
  process.env.AWS_ACCESS_KEY_ID = "test-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests);
  } finally {
    for (const [name, value] of [
      ["AWS_ACCESS_KEY_ID", previous.id],
      ["AWS_SECRET_ACCESS_KEY", previous.secret],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.close();
  }
}

test("Render core start retries HeadBucket until the bundled MinIO accepts the bucket credentials", async () => {
  await withMinio([403, 403, 200], async (endpoint, requests) => {
    const client = s3Client("us-east-1", { endpoint, maxAttempts: 1 });
    try {
      await awaitBucket(client, "qm-storage", 10);
    } finally {
      client.destroy();
    }
    assert.deepEqual(requests, ["HEAD /qm-storage/", "HEAD /qm-storage/", "HEAD /qm-storage/"]);
  });
});

test("Render core start fails at the deadline and keeps the last bucket error as the cause", async () => {
  await withMinio([403], async (endpoint) => {
    const client = s3Client("us-east-1", { endpoint, maxAttempts: 1 });
    try {
      await assert.rejects(awaitBucket(client, "qm-storage", 2), (err: Error) => {
        assert.match(err.message, /did not accept the QM bucket credentials before the startup deadline/);
        assert.equal((err.cause as Error).name, "TimeoutError");
        assert.match((err.cause as Error).message, /403/);
        return true;
      });
    } finally {
      client.destroy();
    }
  });
});
