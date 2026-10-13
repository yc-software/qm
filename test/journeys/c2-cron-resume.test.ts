import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApp, type BuiltApp } from "../../src/wiring.ts";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { scopeId as makeScopeId } from "../../src/types.ts";
import type { CronFireLogEntry } from "../../src/types.ts";
import { testConfig } from "../support/test-config.ts";
import { journeyTestOptions, waitFor } from "./support/journey-app.ts";
import {
  GATEWAY_API_KEY,
  GATEWAY_API_KEY_HEADER,
  GATEWAY_MODEL_ID,
  startFakeGateway,
  type FakeGateway,
} from "./support/fake-gateway.ts";
import { startFakeSlack, type FakeSlack } from "./support/fake-slack.ts";

const OWNER = "U1OWNER";
const CHANNEL = "C1REPORTS";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./support/fake-sprites-preload.ts", import.meta.url));
const LEASE_TTL_MS = 8_000;
const T0 = Date.now();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

interface Core {
  child: ChildProcess;
  log: string[];
  exited: Promise<number | null>;
}

async function startCore(h: { gateway: FakeGateway; slack: FakeSlack; dataDir: string }): Promise<Core> {
  const child = spawn(process.execPath, ["--import", PRELOAD, "src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      DATA_DIR: h.dataDir,
      SESSION_STORE: "postgres",
      HARNESS: "pi",
      PI_MODEL: GATEWAY_MODEL_ID,
      MODEL_GATEWAY_URL: h.gateway.url,
      MODEL_GATEWAY_API_KEY: GATEWAY_API_KEY,
      MODEL_GATEWAY_API_KEY_HEADER: GATEWAY_API_KEY_HEADER,
      SANDBOX_BACKEND: "sprites",
      SPRITES_TOKEN: "test-token",
      SECURITY_SCREEN: "off",
      CONNECTOR_SECRET_KEY: "journey-connector-key",
      CORE_SIGNING_SECRET: "journey-core-signing-secret-0123456789abcdef",
      LEASE_TTL_MS: String(LEASE_TTL_MS),
      REAPER_INTERVAL_MS: "500",
      SHUTDOWN_DRAIN_MS: "1000",
      SLACK_BOT_TOKEN: "xoxb-journey",
      SLACK_API_URL: h.slack.url,
      SLACK_EVENTS_MODE: "http",
      SLACK_SIGNING_SECRET: "journey-signing-secret",
      SLACK_EVENTS_PORT: String(await freePort()),
      SLACK_IDENTITY_EMAIL: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  child.stdout!.on("data", (b: Buffer) => log.push(`+${Date.now() - T0} ${b.toString()}`));
  child.stderr!.on("data", (b: Buffer) => log.push(`+${Date.now() - T0} ${b.toString()}`));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  await waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error(`core exited with ${child.exitCode}`);
      return log.join("").includes("[qm] listening");
    },
    "core to listen",
    60_000,
  ).catch((e) => {
    throw new Error(`${(e as Error).message}\n${log.join("")}`);
  });
  return { child, log, exited };
}

interface Harness {
  gateway: FakeGateway;
  slack: FakeSlack;
  observer: BuiltApp;
  dataDir: string;
  cores: Core[];
  stop(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const slack = await startFakeSlack();
  slack.users.set(OWNER, { id: OWNER, name: "owner", email: "owner@example.com" });
  slack.channels.set(CHANNEL, { id: CHANNEL, name: "reports" });
  const gateway = await startFakeGateway({
    maxRequestBytes: 10 * 1024 * 1024,
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_000,
  });
  gateway.respond = (req) => {
    const marker = /REPORT-[a-z0-9-]+/i.exec(JSON.stringify(req.messages))?.[0] ?? "no-marker";
    return { text: `Daily numbers: ${marker}` };
  };
  const dataDir = mkdtempSync(join(tmpdir(), "qm-journey-c2-"));
  const observer = buildApp(
    testConfig({
      dataDir,
      databaseUrl: process.env.DATABASE_URL!,
      sessionStore: "postgres",
      runStore: "postgres",
      backgroundWorkEnabled: false,
    }),
  );
  await migrateRegisteredPgSchemas(process.env.DATABASE_URL!);
  const cores: Core[] = [];
  return {
    gateway,
    slack,
    observer,
    dataDir,
    cores,
    async stop() {
      for (const core of cores) if (core.child.exitCode === null) core.child.kill("SIGKILL");
      await Promise.all(cores.map((c) => c.exited));
      await observer.runtime.stop();
      await gateway.close();
      await slack.close();
    },
  };
}

async function latestFire(h: Harness, cronId: string): Promise<CronFireLogEntry | undefined> {
  return (await h.observer.crons.listFires(cronId)).runs.at(-1);
}

type Stage = "model" | "tool";

async function interruptCronFire(signal: NodeJS.Signals, stage: Stage): Promise<void> {
  const h = await startHarness();
  const marker = `REPORT-${Date.now().toString(36)}`;
  const finished = `Daily numbers: ${marker}${stage === "tool" ? " tallied" : ""}`;
  const cron = await h.observer.crons.create({
    owner: OWNER,
    createdBy: OWNER,
    ownerScopeId: makeScopeId("personal", OWNER),
    title: "Daily numbers",
    action: `Post the daily numbers. Include the token ${marker} verbatim.`,
    schedule: { firstFireAt: Date.now() + 3_000 },
    destination: { type: "slack", target: CHANNEL, audienceScopeId: makeScopeId("channel", CHANNEL) },
    ownerConsentedAt: Date.now(),
  });
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let toolCalls = 0;
    h.gateway.respond = (req) => {
      if (stage !== "tool" || !req.tools?.length || JSON.stringify(req.messages).includes('"tool_result"'))
        return { text: finished };
      toolCalls++;
      h.gateway.hold = held;
      return { tool: "memory", input: { action: "search", query: "daily numbers" } };
    };
    if (stage === "model") h.gateway.hold = held;
    const first = await startCore(h);
    h.cores.push(first);
    await waitFor(
      async () => h.gateway.requests.length > (stage === "tool" ? 1 : 0),
      `the cron fire to reach the ${stage}`,
      60_000,
    );
    first.child.kill(signal);
    await first.exited;
    h.gateway.hold = null;
    release();
    const second = await startCore(h);
    h.cores.push(second);
    const fire = await waitFor(
      async () => {
        const latest = await latestFire(h, cron.id);
        return latest && latest.status !== "running" && latest.status !== "delivering" ? latest : undefined;
      },
      "the fire to settle",
      45_000,
    ).catch(async (e) => {
      throw new Error(
        `${(e as Error).message}\nfire=${JSON.stringify(await latestFire(h, cron.id))}\nposts=${JSON.stringify(h.slack.posts)}\nB:\n${second.log.join("").slice(-6000)}`,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const posts = h.slack.posts.filter((p) => p.channel === CHANNEL && p.text?.includes(marker));
    assert.deepEqual(
      posts.map((p) => p.text),
      [finished],
      `one post with the finished work; fire=${JSON.stringify(fire)}`,
    );
    assert.equal(fire.status, "ok", fire.note);
    if (stage === "tool") assert.equal(toolCalls, 1, "the resumed turn carries on from the recorded tool result");
  } finally {
    await h.observer.crons.delete(cron.id);
    await h.stop();
  }
}

test(
  "C2: a cron fire whose core is SIGKILLed mid-turn is finished by a fresh core and posted once",
  journeyTestOptions(150_000),
  () => interruptCronFire("SIGKILL", "model"),
);

test(
  "C2: a cron fire whose core is SIGTERMed mid-turn (deploy) is finished by the next core and posted once",
  journeyTestOptions(150_000),
  () => interruptCronFire("SIGTERM", "model"),
);

test(
  "C2: a cron fire killed after its tool work resumes from that work on a fresh core",
  journeyTestOptions(150_000),
  () => interruptCronFire("SIGKILL", "tool"),
);
