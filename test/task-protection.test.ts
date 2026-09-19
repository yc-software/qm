import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createEcsTaskProtection } from "../src/runs/task-protection.ts";

test("an unresponsive ECS protection endpoint cannot hold deployment shutdown", async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const budgets: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    budgets.push(ms);
    return timeout(50);
  });
  t.mock.method(console, "error", () => {});
  let responsive = false;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (responsive) response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const protection = createEcsTaskProtection(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    await protection.set(false);
    responsive = true;
    await protection.set(false);
    assert.equal(requests, 2);
    assert.deepEqual(budgets, [5_000, 5_000]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
