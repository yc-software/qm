import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import type { Config } from "../src/config.ts";
import type { BuiltApp } from "../src/wiring.ts";
import { createTenantContext, currentTenant } from "../src/tenancy/context.ts";
import { createWorkCapacity } from "../src/runs/work-capacity.ts";
import { slackAccountConfigsFromEnv, slackPluginConfigFromEnv } from "../src/slack/config.ts";

let events: string[];
let failure: string | undefined;
let gates: Map<string, Promise<void>>;
let enrolled: boolean;
let slackCount: number;

function enter(event: string): void {
  events.push(event);
  if (event.endsWith(":start")) assert.equal(currentTenant()?.id, "tenant");
  if (failure === event) throw new Error(`${event} failed`);
}

async function step(event: string): Promise<void> {
  enter(event);
  await gates.get(event);
}

mock.module("../src/wiring.ts", {
  namedExports: {
    buildApp: () => {
      enter("build");
      return {
        sandboxResources: { initialize: () => step("sandbox:initialize") },
        crons: { backfillFires: async () => 0 },
        config: { hydrate: () => step("config:hydrate") },
        refreshCustomProviders: () => step("providers:refresh"),
        identity: { hydrate: () => step("identity:hydrate") },
        deploymentLayerReady: Promise.resolve(),
        deploymentLayerRefresh: {
          start: () => enter("refresh:start"),
          stop: () => step("refresh:stop"),
        },
        runtime: {
          start: () => enter("runtime:start"),
          stopBackgroundClaims: () => step("runtime:fence"),
          stop: () => step("runtime:stop"),
          releaseInFlightRuns: () => step("runtime:release"),
        },
        scheduler: {
          start: () => enter("scheduler:start"),
          stop: () => step("scheduler:stop"),
        },
        suggestedActivityMaintenance: {
          start: () => enter("maintenance:start"),
          stop: () => step("maintenance:stop"),
        },
        ...(enrolled ? { backgroundOwnership: { store: {}, deploymentId: "deployment", instanceId: "instance" } } : {}),
      } as unknown as BuiltApp;
    },
    serverDeps: () => ({}),
  },
});

mock.module("../src/api/server.ts", {
  namedExports: { createRequestListener: () => () => {} },
});
mock.module("../src/persistence/pg-pool.ts", {
  namedExports: { migrateRegisteredPgSchemas: () => step("migrate") },
});
mock.module("../src/slack/index.ts", {
  namedExports: {
    slackAccountConfigsFromEnv,
    slackPluginConfigFromEnv,
    startSlackPlugin: async () => ({ stop: async () => {} }),
  },
});
mock.module("../src/surfaces/slack-runtime.ts", {
  namedExports: {
    createSlackRuntimeReconciler: (options: { startPaused: boolean }) => {
      assert.equal(options.startPaused, true);
      const name = `slack:${slackCount++}`;
      enter(`${name}:create`);
      return {
        start: () => enter(`${name}:start`),
        reconcile: () => step(`${name}:reconcile`),
        stop: () => step(`${name}:stop`),
      };
    },
  },
});
mock.module("../src/surfaces/slack-managed.ts", {
  namedExports: { createManagedSlack: () => ({}) },
});
mock.module("../src/runs/background-task-identity.ts", {
  namedExports: {
    backgroundTaskArn: async () => {
      await step("metadata");
      return null;
    },
  },
});
mock.module("../src/deploy/docker-deploy-provider.ts", {
  namedExports: { dockerDaemonFailure: async () => null },
});

const { prepareTenant } = await import("../src/tenancy/runtime.ts");

beforeEach(() => {
  events = [];
  failure = undefined;
  gates = new Map();
  enrolled = false;
  slackCount = 0;
});

function prepare(env: NodeJS.ProcessEnv = {}, workerOnly = false) {
  const context = createTenantContext({ id: "tenant", env });
  const config = {
    backgroundWorkEnabled: true,
    ...(enrolled ? { backgroundDeploymentId: "deployment" } : {}),
  } as Config;
  return prepareTenant(context, config, createWorkCapacity(1), workerOnly);
}

async function start(env: NodeJS.ProcessEnv = {}) {
  const runtime = await prepare(env);
  await runtime.start();
  return runtime;
}

function assertBuiltStopped(): void {
  for (const event of ["runtime:stop", "scheduler:stop", "maintenance:stop", "refresh:stop"])
    assert.ok(events.includes(event), `${event} was not called: ${events.join(", ")}`);
}

test("invalid Slack account configuration fails before constructing or starting a tenant", async () => {
  await assert.rejects(start({ SLACK_ACCOUNTS: "{invalid" }), /SLACK_ACCOUNTS is not valid JSON/);
  assert.deepEqual(events, []);
});

for (const failingStep of ["migrate", "sandbox:initialize", "config:hydrate", "identity:hydrate"]) {
  test(`a ${failingStep} failure closes the partially constructed tenant`, async () => {
    failure = failingStep;
    await assert.rejects(start(), new RegExp(`${failingStep} failed`));
    assert.ok(events.includes("build"));
    assert.equal(events.includes("runtime:start"), false);
    assertBuiltStopped();
  });
}

for (const workerOnly of [false, true]) {
  test(`tenant preparation waits for all migrations before exposing or starting work: workerOnly=${workerOnly}`, async () => {
    const migrated = Promise.withResolvers<void>();
    gates.set("migrate", migrated.promise);
    let prepared = false;
    const preparing = prepare({}, workerOnly).then((runtime) => {
      prepared = true;
      return runtime;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(events, ["build", "migrate"]);
      assert.equal(prepared, false);
    } finally {
      migrated.resolve();
    }
    const runtime = await preparing;
    try {
      assert.equal(Boolean(runtime.listener), !workerOnly);
      assert.equal(events.includes("runtime:start"), false);
      await runtime.start();
      assert.ok(events.includes("runtime:start"));
    } finally {
      await runtime.stop();
    }
  });
}

const accounts = JSON.stringify([
  { id: "one", botToken: "xoxb-one", appToken: "xapp-one" },
  { id: "two", botToken: "xoxb-two", appToken: "xapp-two" },
]);

test("metadata failure cleans all constructed accounts before activating the tenant", async () => {
  enrolled = true;
  failure = "metadata";
  await assert.rejects(start({ SLACK_ACCOUNTS: accounts }), /metadata failed/);
  assert.equal(events.includes("runtime:start"), false);
  assert.equal(events.includes("refresh:start"), false);
  assertBuiltStopped();
  for (let index = 0; index < 3; index++) assert.ok(events.includes(`slack:${index}:stop`));
});

test("preparation initializes the graph without activating any background work", async () => {
  const runtime = await prepare({ SLACK_ACCOUNTS: accounts });
  assert.ok(events.includes("identity:hydrate"));
  assert.equal(events.filter((event) => event.endsWith(":create")).length, 3);
  assert.equal(
    events.some((event) => event.endsWith(":start")),
    false,
  );
  assert.ok(runtime.listener);
  const starting = runtime.start();
  assert.equal(runtime.start(), starting);
  await starting;
  assert.equal(events.filter((event) => event === "runtime:start").length, 1);
  assert.equal(events.filter((event) => event === "refresh:start").length, 1);
  assert.equal(events.filter((event) => /slack:\d+:start/.test(event)).length, 3);
  await runtime.stop();
});

test("stopping a prepared tenant prevents later activation", async () => {
  const runtime = await prepare();
  await runtime.stop();
  await assert.rejects(runtime.start(), /Tenant tenant is stopped/);
  assert.equal(
    events.some((event) => event.endsWith(":start")),
    false,
  );
  assertBuiltStopped();
});

test("worker-only preparation waits for activation and starts no Slack or periodic scheduler", async () => {
  const runtime = await prepare({}, true);
  assert.equal(runtime.listener, undefined);
  assert.equal(
    events.some((event) => event.endsWith(":start")),
    false,
  );
  await runtime.start();
  assert.ok(events.includes("runtime:start"));
  assert.ok(events.includes("refresh:start"));
  assert.equal(events.includes("scheduler:start"), false);
  assert.equal(events.includes("maintenance:start"), false);
  assert.equal(events.includes("slack:0:start"), false);
  await runtime.stop();
});

test("a late startup failure stops the runtime and every constructed Slack account", async () => {
  failure = "scheduler:start";
  await assert.rejects(start({ SLACK_ACCOUNTS: accounts }), /scheduler:start failed/);
  assert.ok(events.includes("runtime:start"));
  assert.ok(events.includes("refresh:start"));
  assertBuiltStopped();
  for (let index = 0; index < 3; index++) assert.ok(events.includes(`slack:${index}:stop`));
});

test("tenant shutdown fences and stops workers before slow Slack and scheduler drains finish", async () => {
  const slack = Promise.withResolvers<void>();
  const scheduler = Promise.withResolvers<void>();
  gates.set("slack:0:stop", slack.promise);
  gates.set("scheduler:stop", scheduler.promise);
  const runtime = await start();
  let stopped = false;
  const stopping = runtime.stop().then(() => {
    stopped = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(events.includes("runtime:fence"));
    assertBuiltStopped();
    assert.equal(stopped, false);
    slack.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
  } finally {
    slack.resolve();
    scheduler.resolve();
    await stopping;
  }
  assert.equal(stopped, true);
});

test("a cleanup failure still attempts every tenant stop and repeated shutdown reuses the result", async () => {
  const runtime = await start();
  failure = "scheduler:stop";
  const stopping = runtime.stop();
  assert.equal(runtime.stop(), stopping);
  await assert.rejects(stopping, AggregateError);
  assertBuiltStopped();
  assert.ok(events.includes("slack:0:stop"));
  assert.equal(events.filter((event) => event === "runtime:stop").length, 1);
});
