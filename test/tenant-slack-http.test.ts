import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { App as BoltApp, Receiver, ReceiverEvent } from "@slack/bolt";
import { createHttpEventsReceiver } from "../src/slack/http-events.ts";
import { createTenantSlackHttp } from "../src/tenancy/slack-http.ts";
import { createTenantContext, currentTenant, runWithTenant } from "../src/tenancy/context.ts";
import { createTenantRouter } from "../src/tenancy/router.ts";

const envelope = {
  type: "event_callback",
  event_id: "Ev123",
  event: { type: "message", channel: "C1", ts: "1.1", user: "U1", text: "hi" },
};

function signed(body: unknown, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  return {
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`,
    },
  };
}

function initialize(receiver: Receiver, processEvent: (event: ReceiverEvent) => Promise<void>): void {
  receiver.init?.({ processEvent } as unknown as BoltApp);
}

function call(port: number, path: string, headers: Record<string, string>, body?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve(new Response(text, { status: res.statusCode! })));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("external Slack receivers share a listener across tenants without binding their configured event ports", async () => {
  const seen: Array<{ tenant: string | undefined; retryNum?: number }> = [];
  const tenants = ["first", "second"].map((id) => {
    const context = createTenantContext({ id, env: {}, pooled: true });
    const ingress = runWithTenant(context, createTenantSlackHttp);
    return { id, context, ingress };
  });
  const listener = createTenantRouter(
    tenants.map(({ id, context, ingress }) => ({
      context,
      hosts: [`${id}.example`],
      listener: (req, res) => {
        void ingress.handle(req, res).then((handled) => {
          if (!handled) {
            res.writeHead(404);
            res.end();
          }
        });
      },
    })),
    true,
  );
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const receivers = tenants.map(({ id, ingress }) => {
    const config = ingress.wrap({ botToken: "xoxb-test", eventsMode: "http", signingSecret: id, eventsPort: port });
    const receiver = config.receiverFactory!();
    initialize(receiver, async (event) => {
      seen.push({ tenant: currentTenant()?.id, retryNum: event.retryNum });
      await event.ack();
    });
    return receiver;
  });
  const post = (tenant: string, secret: string, body: unknown = envelope, timestamp?: number) => {
    const request = signed(body, secret, timestamp);
    return call(
      port,
      "/slack/events",
      { ...request.headers, host: `${tenant}.example`, "x-slack-retry-num": "2" },
      request.body,
    );
  };
  try {
    assert.equal((await post("first", "first")).status, 503);
    await Promise.all(receivers.map((receiver) => receiver.start(0 as never)));
    assert.equal((await post("first", "first")).status, 200);
    assert.equal((await post("second", "second")).status, 200);
    assert.equal((await post("first", "second")).status, 401);
    assert.equal((await post("second", "first")).status, 401);
    assert.equal((await post("first", "first", envelope, Math.floor(Date.now() / 1000) - 3_600)).status, 401);
    assert.deepEqual(seen, [
      { tenant: "first", retryNum: 2 },
      { tenant: "second", retryNum: 2 },
    ]);
    const verified = await post("first", "first", { type: "url_verification", challenge: "challenge" });
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), { challenge: "challenge" });
    assert.equal((await post("first", "first", null)).status, 400);
    await receivers[0]!.stop(0 as never);
    assert.equal((await post("first", "first")).status, 503);
    assert.equal((await post("second", "second")).status, 200);
    const missing = await call(port, "/elsewhere", { host: "second.example" });
    assert.equal(missing.status, 404);
  } finally {
    await Promise.all(receivers.map((receiver) => receiver.stop(0 as never)));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("named Slack account paths are isolated and managed or socket receivers stay unchanged", async () => {
  const ingress = createTenantSlackHttp();
  const socket = { botToken: "xoxb-socket", eventsMode: "socket" as const };
  const managed = { botToken: "xoxb-managed", eventsMode: "http" as const, receiverFactory: () => ({}) as Receiver };
  assert.equal(ingress.wrap(socket), socket);
  assert.equal(ingress.wrap(managed), managed);
  assert.throws(() => ingress.wrap({ botToken: "xoxb-test", eventsMode: "http" }), /signing secret/);
  const config = ingress.wrap({
    botToken: "xoxb-test",
    eventsMode: "http",
    accountId: "sales team",
    signingSecret: "sales",
  });
  const receiver = config.receiverFactory!();
  const duplicate = config.receiverFactory!();
  initialize(receiver, async (event) => {
    await event.ack();
  });
  initialize(duplicate, async (event) => {
    await event.ack();
  });
  const server = createServer((req, res) => {
    void ingress.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string) => fetch(`${url}${path}`, { method: "POST", ...signed(envelope, "sales") });
  try {
    await receiver.start(0 as never);
    await assert.rejects(duplicate.start(0 as never), /already active/);
    await duplicate.stop(0 as never);
    assert.equal((await post("/slack/accounts/sales%20team/events")).status, 200);
    assert.equal((await post("/slack/accounts/other/events")).status, 503);
    assert.equal((await post("/slack/events")).status, 503);
    await receiver.stop(0 as never);
    await duplicate.start(0 as never);
    await receiver.stop(0 as never);
    assert.equal((await post("/slack/accounts/sales%20team/events")).status, 200);
  } finally {
    await receiver.stop(0 as never);
    await duplicate.stop(0 as never);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("external receiver shutdown fences new requests and drains accepted event handlers", async () => {
  const receiver = createHttpEventsReceiver({ externalListener: true, signingSecret: "drain", port: 4444 });
  assert.equal("server" in receiver, false);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  initialize(receiver, async (event) => {
    entered.resolve();
    await finish.promise;
    await event.ack();
  });
  const server = createServer((req, res) => {
    void receiver.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slack/events`;
  const post = () => fetch(url, { method: "POST", ...signed(envelope, "drain") });
  try {
    await receiver.start(0 as never);
    const pending = post();
    await entered.promise;
    let stopped = false;
    const stopping = receiver.stop(0 as never).then(() => {
      stopped = true;
    });
    assert.equal((await post()).status, 503);
    assert.equal(stopped, false);
    finish.resolve();
    assert.equal((await pending).status, 200);
    await stopping;
    assert.equal(stopped, true);
  } finally {
    finish.resolve();
    await receiver.stop(0 as never);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
