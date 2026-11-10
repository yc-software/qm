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

async function statusOf(url: string, init?: RequestInit): Promise<number | string> {
  return fetch(url, init).then(
    async (response) => (await response.text(), response.status),
    (error: { cause?: { code?: string } }) => error.cause?.code ?? "failed",
  );
}

async function slackReceiver(): Promise<number> {
  const receiver = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "text/plain" }).end("answered"));
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiver.unref();
  return (receiver.address() as AddressInfo).port;
}

test("shutdown reports unhealthy and keeps the front door and core serving until the drain deadline", async (t) => {
  const [port, publicPort] = [await freePort(), await freePort()];
  const config = testConfig({
    allowUnauthenticatedCore: true,
    port,
    publicPort,
    slackEventsPort: await slackReceiver(),
    shutdownDrainMs: 1_500,
  });
  process.env.PORTAL_SESSION_SECRET = "shutdown-sequencing-session-secret-0123456789";
  const qm = await startQm(config, { agent: createMockAgent(), env: process.env });
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopped ??= qm.stop());
  t.after(stop);
  const core = `http://127.0.0.1:${port}`;
  const front = `http://127.0.0.1:${publicPort}`;
  const slackEvent = () => statusOf(`${front}/slack/events`, { method: "POST", body: "{}" });
  assert.equal(await statusOf(`${front}/healthz`), 200);
  assert.equal(await statusOf(`${core}/healthz`), 200);

  const startedStopping = Date.now();
  const stopping = stop();
  assert.equal(await statusOf(`${front}/healthz`), 503);
  assert.equal(await statusOf(`${front}/readyz`), 503);
  assert.equal(await statusOf(`${core}/healthz`), 503);
  assert.equal(await slackEvent(), 200);

  await stopping;
  assert.ok(Date.now() - startedStopping >= config.shutdownDrainMs);
  assert.equal(await statusOf(`${front}/healthz`), "ECONNREFUSED");
  assert.equal(await statusOf(`${core}/healthz`), "ECONNREFUSED");
});
