import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mock, test } from "node:test";
import type { Receiver, ReceiverEvent } from "@slack/bolt";
import type { SlackCoreClient, SlackPluginConfig } from "../src/slack/index.ts";
import { createTenantContext, runWithTenant } from "../src/tenancy/context.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { StagedEnvelope } from "../src/slack/envelope-staging.ts";
import { SlackPluginStartCleanupError } from "../src/surfaces/slack-runtime.ts";
import { assertSlackEventIdentity } from "../src/slack/connection-ownership.ts";

interface Behavior {
  teamId: string;
  userId: string;
  appId: string;
  appIdViaBot?: boolean;
  authGate?: Promise<void>;
  authError?: Error;
  startError?: Error;
  stopFailures?: number;
}

const behaviors = new Map<string, Behavior>();

class FakeSocketModeClient extends EventEmitter {
  async start(): Promise<void> {}
  async disconnect(): Promise<void> {}
}

class FakeApp {
  static instances: FakeApp[] = [];
  readonly behavior: Behavior;
  readonly receiver: Receiver;
  readonly client;
  authCalls = 0;
  botInfoCalls = 0;
  startCalls = 0;
  processed: ReceiverEvent[] = [];

  constructor(opts: { token: string; receiver: Receiver }) {
    this.behavior = behaviors.get(opts.token)!;
    this.receiver = opts.receiver;
    this.client = {
      auth: {
        test: async () => {
          this.authCalls++;
          await this.behavior.authGate;
          if (this.behavior.authError) throw this.behavior.authError;
          return {
            team_id: this.behavior.teamId,
            user_id: this.behavior.userId,
            bot_id: `${this.behavior.userId}-bot`,
            user: "test-bot",
            team: this.behavior.teamId,
            ...(!this.behavior.appIdViaBot ? { app_id: this.behavior.appId } : {}),
          };
        },
      },
      bots: {
        info: async () => {
          this.botInfoCalls++;
          return { bot: { app_id: this.behavior.appId } };
        },
      },
      emoji: { list: async () => ({ emoji: {} }) },
      async *paginate() {
        yield { members: [] };
      },
    };
    this.receiver.init?.(this as never);
    FakeApp.instances.push(this);
  }

  message(): void {}
  event(): void {}
  action(): void {}
  async processEvent(event: ReceiverEvent): Promise<void> {
    this.processed.push(event);
    await event.ack();
  }
  async start(): Promise<void> {
    this.startCalls++;
    await this.receiver.start();
    if (this.behavior.startError) throw this.behavior.startError;
  }
  async stop(): Promise<void> {
    if (this.behavior.stopFailures) {
      this.behavior.stopFailures--;
      throw new Error("disconnect failed");
    }
    await this.receiver.stop();
  }
}

const actualBolt = (await import("@slack/bolt")).default;
mock.module("@slack/bolt", { defaultExport: { ...actualBolt, App: FakeApp } });
mock.module("@slack/socket-mode", { namedExports: { SocketModeClient: FakeSocketModeClient } });
mock.module("@slack/web-api", { namedExports: { WebClient: class {} } });
const { startSlackPlugin } = await import("../src/slack/index.ts");
const { createTenantSlackHttp } = await import("../src/tenancy/slack-http.ts");

function fixture(id: string, behavior: Partial<Behavior> = {}, config: Partial<SlackPluginConfig> = {}) {
  const context = createTenantContext({ id, env: {}, pooled: true });
  const resolved = { teamId: `T-${id}`, userId: `U-${id}`, appId: `A-${id}`, ...behavior };
  const cfg: SlackPluginConfig = {
    botToken: `xoxb-${id}`,
    appToken: `xapp-${id}`,
    coreSingleton: false,
    identityEmail: "0",
    ackCapMs: 1,
    ...config,
  };
  behaviors.set(cfg.botToken, resolved);
  const stagedEnvelopes = createMemoryMap<StagedEnvelope>();
  const core = {
    stagedEnvelopes,
    ackEmojiOverride: async () => null,
    internalMemberOverrides: async () => [],
    holdEnvelopeReplay: async (_account: string, replay: () => Promise<unknown>) => replay(),
  } as unknown as SlackCoreClient;
  return {
    context,
    behavior: resolved,
    config: cfg,
    stagedEnvelopes,
    start: (override: Partial<SlackPluginConfig> = {}) =>
      runWithTenant(context, () => startSlackPlugin({ ...cfg, ...override }, core)),
  };
}

test("concurrent socket starts reserve the app token before authentication", async () => {
  const gate = Promise.withResolvers<void>();
  const alpha = fixture("token-alpha", { authGate: gate.promise });
  const bravo = fixture("token-bravo", {}, { appToken: alpha.config.appToken });
  const starting = alpha.start();
  const first = FakeApp.instances.at(-1)!;
  try {
    await assert.rejects(bravo.start(), /app token already has an active connection/);
    const rejected = FakeApp.instances.at(-1)!;
    assert.equal(first.authCalls, 1);
    assert.equal(rejected.authCalls, 0);
    assert.equal(rejected.startCalls, 0);
  } finally {
    gate.resolve();
    await (await starting).stop();
  }
  const restarted = await bravo.start();
  await restarted.stop();
});

test("rotated tokens cannot claim an active bot identity and can restart after stop", async () => {
  const alpha = fixture("identity-alpha");
  const bravo = fixture("identity-bravo", alpha.behavior);
  const results = await Promise.allSettled([alpha.start(), bravo.start()]);
  const winner = results.find((result) => result.status === "fulfilled");
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(String(rejected?.reason), /bot identity already has an active connection/);
  assert.ok(winner?.status === "fulfilled");
  await winner.value.stop();
  const restarted = await bravo.start();
  await winner.value.stop();
  await assert.rejects(alpha.start(), /bot identity already has an active connection/);
  await restarted.stop();
  const sameTenant = await bravo.start();
  try {
    await assert.rejects(bravo.start(), /bot token already has an active connection/);
  } finally {
    await sameTenant.stop();
  }
});

test("different app tokens for one socket app cannot split its workspace stream", async () => {
  const alpha = fixture("socket-alpha", { appIdViaBot: true });
  const bravo = fixture("socket-bravo", { appId: alpha.behavior.appId, appIdViaBot: true });
  const running = await alpha.start();
  assert.equal(FakeApp.instances.at(-1)!.botInfoCalls, 1);
  try {
    await assert.rejects(bravo.start(), /socket app already has an active connection/);
  } finally {
    await running.stop();
  }
  const restarted = await bravo.start();
  await restarted.stop();
});

test("independent tenant apps can run concurrently", async () => {
  const tenants = [fixture("distinct-alpha"), fixture("distinct-bravo")];
  const running = await Promise.all(tenants.map((tenant) => tenant.start()));
  await Promise.all(running.map((plugin) => plugin.stop()));
});

test("managed receivers may share an app across separate workspace installations", async () => {
  const receiverFactory = () => ({ init: () => {}, start: async () => {}, stop: async () => {} });
  const tenants = [
    fixture("managed-alpha", { appId: "A-managed" }, { receiverFactory }),
    fixture("managed-bravo", { appId: "A-managed" }, { receiverFactory }),
  ];
  const running = await Promise.all(tenants.map((tenant) => tenant.start()));
  await Promise.all(running.map((plugin) => plugin.stop()));
});

test("dedicated starts preserve existing authentication without extra app identity queries", async () => {
  const tenant = fixture("dedicated", { appIdViaBot: true });
  const context = createTenantContext({ id: tenant.context.id, env: {} });
  const running = await runWithTenant(context, () =>
    startSlackPlugin(tenant.config, {
      ackEmojiOverride: async () => null,
      internalMemberOverrides: async () => [],
    } as unknown as SlackCoreClient),
  );
  assert.equal(FakeApp.instances.at(-1)!.botInfoCalls, 0);
  await running.stop();
});

test("failed startup retains ownership until pending socket cleanup succeeds", async () => {
  const alpha = fixture("cleanup-alpha", { startError: new Error("start failed"), stopFailures: 1 });
  const bravo = fixture("cleanup-bravo", {}, { appToken: alpha.config.appToken });
  let failure: SlackPluginStartCleanupError | undefined;
  await assert.rejects(alpha.start(), (error) => {
    assert.ok(error instanceof SlackPluginStartCleanupError);
    failure = error;
    return true;
  });
  await assert.rejects(bravo.start(), /app token already has an active connection/);
  await failure!.cleanup();
  const running = await bravo.start();
  await running.stop();
});

test("failed normal stop retains ownership until a successful retry", async () => {
  const alpha = fixture("stop-alpha", { stopFailures: 1 });
  const bravo = fixture("stop-bravo", {}, { appToken: alpha.config.appToken });
  const running = await alpha.start();
  await assert.rejects(running.stop(), /disconnect failed/);
  await assert.rejects(bravo.start(), /app token already has an active connection/);
  await running.stop();
  const restarted = await bravo.start();
  await restarted.stop();
});

test("authentication failure releases reservations after successful cleanup", async () => {
  const alpha = fixture("auth-alpha", { authError: new Error("invalid_auth") });
  const bravo = fixture("auth-bravo", {}, { appToken: alpha.config.appToken });
  await assert.rejects(alpha.start(), /invalid_auth/);
  const running = await bravo.start();
  await running.stop();
});

test("installed workspace and app checks preserve Slack Connect owner semantics", () => {
  const expected = { teamId: "TOwner", appId: "AOwner" };
  const body = {
    type: "event_callback",
    team_id: "TOuter",
    api_app_id: "AOwner",
    authorizations: [{ team_id: "TOwner" }],
    event: { user_team: "TAuthor", team: "TAuthor" },
  };
  assert.doesNotThrow(() => assertSlackEventIdentity(body, expected));
  assert.throws(() => assertSlackEventIdentity({ ...body, api_app_id: "AForeign" }, expected));
  assert.throws(() => assertSlackEventIdentity({ ...body, authorizations: [{ team_id: "TForeign" }] }, expected));
  assert.throws(() => assertSlackEventIdentity({ type: "event_callback", api_app_id: "AOwner" }, expected));
  assert.doesNotThrow(() =>
    assertSlackEventIdentity({ ...body, team_id: "TOwner", authorizations: [{ team_id: null }] }, expected),
  );
  assert.doesNotThrow(() =>
    assertSlackEventIdentity(
      { type: "block_actions", team: { id: "TActor" }, view: { app_installed_team_id: "TOwner", app_id: "AOwner" } },
      expected,
    ),
  );
});

test("socket events for another installation never arm durable staging", async () => {
  const tenant = fixture("socket-events");
  const running = await tenant.start();
  const app = FakeApp.instances.at(-1)!;
  const socket = (app.receiver as Receiver & { client: FakeSocketModeClient }).client;
  const receive = socket.listeners("slack_event")[0] as (event: {
    body: Record<string, unknown>;
    ack: () => Promise<void>;
  }) => Promise<void>;
  let acked = 0;
  const ack = async () => {
    acked++;
  };
  const body = {
    type: "event_callback",
    team_id: tenant.behavior.teamId,
    api_app_id: tenant.behavior.appId,
    event: { type: "message", channel: "C1", ts: "1.1", user_team: "T-foreign-author" },
  };
  try {
    await receive({ body: { ...body, team_id: "T-foreign" }, ack });
    await receive({ body: { ...body, api_app_id: "A-foreign" }, ack });
    assert.equal(app.processed.length, 0);
    assert.equal(acked, 0);
    assert.deepEqual(await tenant.stagedEnvelopes.entries(), []);
    await receive({ body, ack });
    assert.equal(app.processed.length, 1);
    assert.equal(acked, 1);
  } finally {
    await running.stop();
  }
});

test("signed HTTP events for another installation are rejected before processing or durable staging", async () => {
  const secret = "shared-test-signing-secret";
  const tenant = fixture("http-owner", {}, { eventsMode: "http", signingSecret: secret });
  const ingress = runWithTenant(tenant.context, createTenantSlackHttp);
  const running = await tenant.start(ingress.wrap(tenant.config));
  const app = FakeApp.instances.at(-1)!;
  const server = createServer((req, res) => void ingress.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const post = async (body: unknown) => {
    const raw = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${address.port}/slack/events`, {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`,
      },
      body: raw,
    });
  };
  const body = {
    type: "event_callback",
    team_id: tenant.behavior.teamId,
    api_app_id: tenant.behavior.appId,
    event: { type: "message", channel: "C1", ts: "1.1", user_team: "T-foreign-author" },
  };
  try {
    assert.equal((await post({ ...body, team_id: "T-foreign" })).status, 503);
    assert.equal((await post({ ...body, api_app_id: "A-foreign" })).status, 503);
    assert.equal(app.processed.length, 0);
    assert.deepEqual(await tenant.stagedEnvelopes.entries(), []);
    assert.equal((await post(body)).status, 200);
    assert.equal(app.processed.length, 1);
    const verification = await post({ type: "url_verification", challenge: "challenge" });
    assert.equal(verification.status, 200);
    assert.deepEqual(await verification.json(), { challenge: "challenge" });
  } finally {
    await running.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
