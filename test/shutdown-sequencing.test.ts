import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { test } from "node:test";
import { startQm } from "../src/start.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { testConfig } from "./support/test-config.ts";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function statusOf(url: string): Promise<number | string> {
  return fetch(url).then(
    (response) => response.status,
    (error: { cause?: { code?: string } }) => error.cause?.code ?? "failed",
  );
}

function heldSlackReceiver(): { port: Promise<number>; received: Promise<void>; release(): void } {
  let release = (): void => {};
  let received = (): void => {};
  const receivedOnce = new Promise<void>((resolve) => (received = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const receiver = createHttpServer((req, res) => {
    received();
    req.resume();
    void released.then(() => res.writeHead(200, { "content-type": "text/plain" }).end("held-and-answered"));
  });
  const port = new Promise<number>((resolve) =>
    receiver.listen(0, "127.0.0.1", () => resolve((receiver.address() as AddressInfo).port)),
  );
  receiver.unref();
  return { port, received: receivedOnce, release };
}

test("shutdown closes the front door before core, and core serves the front door's in-flight request", async (t) => {
  const receiver = heldSlackReceiver();
  const [port, publicPort] = [await freePort(), await freePort()];
  const config = testConfig({
    allowUnauthenticatedCore: true,
    port,
    publicPort,
    slackEventsPort: await receiver.port,
    shutdownDrainMs: 10_000,
  });
  const qm = await startQm(config, { agent: createMockAgent(), env: process.env });
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopped ??= qm.stop());
  t.after(stop);
  const core = `http://127.0.0.1:${port}`;
  const front = `http://127.0.0.1:${publicPort}`;
  assert.equal(await statusOf(`${front}/healthz`), 200);
  assert.equal(await statusOf(`${core}/healthz`), 200);

  const inFlight = fetch(`${front}/slack/events`, { method: "POST", body: "{}" });
  await receiver.received;
  const startedStopping = Date.now();
  const stopping = stop();

  while ((await statusOf(`${front}/healthz`)) !== "ECONNREFUSED")
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await statusOf(`${core}/healthz`), 503);
  assert.equal(await statusOf(`${core}/readyz`), 503);

  receiver.release();
  const answered = await inFlight;
  assert.equal(answered.status, 200);
  assert.equal(await answered.text(), "held-and-answered");
  await stopping;
  assert.ok(Date.now() - startedStopping < config.shutdownDrainMs, "nothing held core open until the drain deadline");
  assert.equal(await statusOf(`${core}/healthz`), "ECONNREFUSED");
});
