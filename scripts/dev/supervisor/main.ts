import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  HEARTBEAT_INTERVAL_MS,
  lockDir as lockDirFor,
  readPidFile,
  writeHeartbeat,
  writeMeta,
  writePidFile,
  writeState,
} from "../lib/lease.ts";
import { slotPorts, slotTokens, poolStore } from "../lib/pool.ts";
import { assembleEnv, completeDevSecuritySecrets, currentBranch, gitHead, seedEnvFromMain } from "../lib/envctx.ts";
import { ensureDeps } from "../lib/deps.ts";
import { destroyLocalDevSandboxes, resolveSandbox, type SandboxResolution } from "../lib/sandbox.ts";
import { adminGrantCount, checkPostgres, ensureLocalPostgres, firstAdminPrincipal } from "../lib/postgres.ts";
import { killTree } from "../lib/proc.ts";
import { envFileGet } from "../lib/envctx.ts";
import { envSha as computeEnvSha, errMessage, nowEpoch, sleep } from "../lib/util.ts";
import { discoverCanaryChannel } from "../lib/canary.ts";
import { buildChildSpecs, type SpecInputs } from "./specs.ts";
import { Child } from "./children.ts";
import type { BootPhaseEvent, BootResult, BootSpec, ChildName, SlackHealth, StatusReport } from "../lib/types.ts";
import { CHILD_ORDER, EXIT } from "../lib/types.ts";

const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_FAIL_THRESHOLD = 3;
const CANARY_INTERVAL_MS = Number(process.env.DEV_INSTANCE_CANARY_INTERVAL_MS || 10 * 60_000);
const IDLE_HOURS = (() => {
  const raw = process.env.DEV_INSTANCE_IDLE_HOURS;
  if (raw === undefined || raw === "") return 8;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[supervisor] DEV_INSTANCE_IDLE_HOURS=${raw} is not a number -- using the 8h default`);
    return 8;
  }
  return n;
})();

const { values: args } = parseArgs({
  options: {
    slot: { type: "string" },
    store: { type: "string" },
    worktree: { type: "string" },
  },
});
if (!args.slot || !args.worktree) {
  console.error("usage: supervisor --slot poolN --worktree <path> [--store <dir>]");
  process.exit(EXIT.usage);
}

const slot = args.slot;
const store = args.store || poolStore();
const worktree = args.worktree;
const lock = lockDirFor(slot, store);
const ports = slotPorts(slot);
const startedAt = nowEpoch();

const events: BootPhaseEvent[] = [];
const subscribers = new Set<(e: BootPhaseEvent) => void>();
let bootDone = false;
let bootResult: BootResult | null = null;
let phaseName = "boot";
let shuttingDown = false;

const children = new Map<ChildName, Child>();
const healthFails = new Map<ChildName, number>();
let specInputs: SpecInputs | null = null;
let currentEnvSha = "";
let currentGitSha = "";
let handle = "";
let sandbox: SandboxResolution | null = null;
let durability = { sessionStore: "memory", runStore: "memory", databaseUrl: "" };
let harness = "mock";
let watch = true;
let bootId = "";
let bootedAt: number | null = null;
let lastSlackHealth: SlackHealth | null = null;
let canaryChannel = "";
let canaryChannelSource = "";
let lastControlAt = nowEpoch();
let lastSlackActivitySec = 0;

function log(msg: string): void {
  console.log(`[supervisor:${slot}] ${msg}`);
}

function emit(e: BootPhaseEvent): void {
  events.push(e);
  for (const sub of subscribers) sub(e);
}

function phase(name: string, state: "start" | "ok" | "warn" | "fail", detail?: string): void {
  phaseName = name;
  emit({ event: "phase", name, state, detail });
  log(`${name}: ${state}${detail ? ` -- ${detail}` : ""}`);
}

function readBootSpec(): BootSpec {
  return JSON.parse(readFileSync(join(lock, "boot-spec.json"), "utf8")) as BootSpec;
}

const slackOn = (spec: BootSpec): boolean => spec.slack !== false;

async function resolveCanaryChannel(spec: BootSpec): Promise<void> {
  if (!slackOn(spec)) return;
  if (spec.canaryChannel) {
    canaryChannel = spec.canaryChannel;
    canaryChannelSource = "configured";
    return;
  }
  const tokens = slotTokens(slot, store);
  let found = await discoverCanaryChannel(tokens.botToken);
  if (!found) {
    await sleep(2000);
    found = await discoverCanaryChannel(tokens.botToken);
  }
  if (found) {
    canaryChannel = found.id;
    canaryChannelSource = `auto-discovered #${found.name}`;
    emit({
      event: "phase",
      name: "canary",
      state: "ok",
      detail: `channel auto-discovered: #${found.name} (canary messages are deleted after each round trip)`,
    });
    log(`canary channel auto-discovered: #${found.name}`);
  } else if (!canaryChannel) {
    log(
      "canary channel discovery found no dev-canary or ci-* throwaway channel (or the Slack API was unreachable) -- will retry on the periodic canary tick",
    );
  }
}

function logTail(name: ChildName, lines = 20): string[] {
  try {
    return readFileSync(join(lock, `${name}.log`), "utf8")
      .trimEnd()
      .split("\n")
      .slice(-lines);
  } catch {
    return [];
  }
}

async function fetchSlackHealth(): Promise<SlackHealth | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${ports.slackHealth}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as SlackHealth;
  } catch {
    return null;
  }
}

async function runCanary(
  channel: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; rttMs?: number; reason?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${ports.slackHealth}/canary`, {
      method: "POST",
      body: JSON.stringify({ channel, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5000),
    });
    return (await res.json()) as { ok: boolean; rttMs?: number; reason?: string };
  } catch (err) {
    return { ok: false, reason: `canary endpoint unreachable: ${errMessage(err)}` };
  }
}

async function verifySlack(spec: BootSpec): Promise<{ ok: boolean; result: Partial<BootResult> }> {
  let health: SlackHealth | null = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    health = await fetchSlackHealth();
    if (health?.connectedAs) break;
    await sleep(500);
  }
  lastSlackHealth = health;
  if (!health?.connectedAs) {
    return { ok: false, result: { reason: "slack introspection endpoint never reported a connection" } };
  }
  if (health.connectedAs) handle = health.connectedAs;

  if ((health.numConnections ?? 1) > 1) {
    await sleep(5000);
    health = (await fetchSlackHealth()) ?? health;
    lastSlackHealth = health;
    if ((health.numConnections ?? 1) > 1) {
      return {
        ok: false,
        result: {
          reason: "slot-stolen",
          numConnections: health.numConnections,
          helloHost: health.helloHost ?? null,
          rotateSuggested: true,
        },
      };
    }
  }
  const exclusivityUnknown = health.numConnections === null || health.numConnections === undefined;

  const channel = canaryChannel;
  if (!channel) {
    if (spec.strict) return { ok: false, result: { reason: "no canary channel configured and --strict set" } };
    if (exclusivityUnknown) {
      return {
        ok: false,
        result: {
          reason:
            "introspection degraded (num_connections unknown) and no canary channel to prove delivery -- check slack.log",
        },
      };
    }
    phase(
      "canary",
      "warn",
      "delivery unverified -- set CANARY_CHANNEL in the slot env (or DEV_INSTANCE_CANARY_CHANNEL) to prove event delivery at boot",
    );
    return { ok: true, result: { canary: null, numConnections: health.numConnections ?? null } };
  }
  let last: { ok: boolean; rttMs?: number; reason?: string } = { ok: false, reason: "not run" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await runCanary(channel);
    if (last.ok) break;
    phase("canary", "warn", `attempt ${attempt}/3 failed: ${last.reason}`);
    await sleep(1500);
  }
  if (!last.ok) {
    return {
      ok: false,
      result: {
        reason: "canary-failed",
        canary: last,
        numConnections: health.numConnections ?? null,
        rotateSuggested: true,
      },
    };
  }
  if (exclusivityUnknown) {
    if (spec.strict)
      return {
        ok: false,
        result: { reason: "introspection degraded (num_connections unknown) under --strict", canary: last },
      };
    phase(
      "verify",
      "warn",
      "num_connections unknown (introspection tap degraded) -- delivery proven by canary, exclusivity unverified",
    );
  }
  return {
    ok: true,
    result: { canary: last, numConnections: health.numConnections ?? null, helloHost: health.helloHost ?? null },
  };
}

function writeLegacyMeta(booting: boolean): void {
  const branch = specInputs ? currentBranch(worktree) : "?";
  const meta: Record<string, string> = {
    slot,
    worktree,
    branch,
    port: String(ports.core),
    web_port: String(ports.web),
    admin_port: String(ports.admin),
    portal_port: String(ports.portal),
    handle,
    supervisor_pid: String(process.pid),
    session_store: durability.sessionStore,
    run_store: durability.runStore,
    watch: watch ? "1" : "0",
    slack: slackOn(readBootSpec()) ? "1" : "0",
    created_epoch: String(startedAt),
    created: new Date(startedAt * 1000).toISOString().replace("T", " ").slice(0, 19),
  };
  if (booting) {
    meta.booting = "1";
    meta.owner_pid = String(process.pid);
  }
  writeMeta(lock, meta);
}

function persistState(): void {
  writeState(lock, {
    version: 1,
    slot,
    worktree,
    supervisorPid: process.pid,
    socketPath: socketPathResolved,
    ports,
    handle,
    phase: bootPhase(),
    bootId,
    envSha: currentEnvSha,
    gitSha: currentGitSha,
    sandbox: sandbox ? { backend: sandbox.backend, detail: sandbox.detail } : null,
    harness,
  });
}

async function assembleAndPrepare(spec: BootSpec): Promise<SpecInputs> {
  phase("env", "start");
  seedEnvFromMain(worktree, log);
  const assembled = await assembleEnv({
    worktree,
    callerEnv: spec.callerEnv,
    allowMock: spec.callerEnv.DEV_INSTANCE_ALLOW_MOCK === "1",
    log,
  });
  for (const w of assembled.warnings) phase("env", "warn", w);
  harness = assembled.harness;
  let harnessDetail = `live ${assembled.harness} turns (anthropic key from ${assembled.anthropicKeySource})`;
  if (assembled.harness === "mock") harnessDetail = "mock turns";
  else if (assembled.harness === "codex") {
    harnessDetail = assembled.codexAuthSource
      ? "live codex turns (ChatGPT OAuth auth.json)"
      : `live codex turns (openai key from ${assembled.openaiKeySource || "the environment"})`;
  } else if (assembled.harness === "claude") harnessDetail = "live claude turns (native CLI authentication)";
  phase("env", "ok", harnessDetail);

  phase("deps", "start");
  await ensureDeps(worktree, { watch: spec.watch, webUiBasePath: spec.callerEnv.DEV_INSTANCE_WEB_UI_BASE || "/" }, log);
  phase("deps", "ok");

  phase("sandbox", "start");
  sandbox = await resolveSandbox({
    worktree,
    requested: spec.sandbox,
    corePort: ports.core,
    lock,
    baseEnv: assembled.env,
    log,
  });
  for (const w of sandbox.warnings) phase("sandbox", "warn", w);
  phase("sandbox", "ok", sandbox.detail);

  phase("durability", "start");
  let databaseUrl = assembled.env.DATABASE_URL || envFileGet(join(worktree, ".env"), "DATABASE_URL");
  let adminGrantsSeed = assembled.env.ADMIN_GRANTS || envFileGet(join(worktree, ".env"), "ADMIN_GRANTS");
  let sessionStore = "memory";
  let runStore = "memory";
  let localPg = false;
  let durableAdminPrincipal = "";
  if (!databaseUrl) {
    try {
      const pg = await ensureLocalPostgres(worktree, log);
      databaseUrl = pg.url;
      localPg = true;
    } catch (err) {
      if (assembled.env.DEV_INSTANCE_ALLOW_MEMORY === "1") {
        phase("durability", "warn", "memory stores explicitly allowed by DEV_INSTANCE_ALLOW_MEMORY=1");
      } else {
        throw new Error(
          `DATABASE_URL is required and local Docker Postgres could not be started (${errMessage(err)}). Export DATABASE_URL, add it to ${assembled.liveEnvFile} or .env, or set DEV_INSTANCE_ALLOW_MEMORY=1 for a deliberate ephemeral wiring check.`,
          { cause: err },
        );
      }
    }
  }
  if (databaseUrl) {
    sessionStore = "postgres";
    runStore = "postgres";
    await checkPostgres(worktree, databaseUrl).catch((err) => {
      throw new Error(`could not connect to DATABASE_URL: ${errMessage(err)}`, { cause: err });
    });
    const grants = await adminGrantCount(worktree, databaseUrl);
    if (grants === 0 && !adminGrantsSeed) {
      if (localPg) {
        const principal = assembled.env.DEV_INSTANCE_ADMIN_PRINCIPAL || assembled.env.USER || "dev-admin";
        adminGrantsSeed = `${principal}:org_admin`;
        log(`admin grants: local Postgres will seed ${principal}:org_admin if the store is empty`);
      } else {
        throw new Error(
          "Postgres has no existing admin grants and ADMIN_GRANTS is unset. Set ADMIN_GRANTS=<principal>:org_admin for the first boot of this dev DB, or point DATABASE_URL at a DB that already has admin_grants.",
        );
      }
    }
    durableAdminPrincipal = await firstAdminPrincipal(worktree, databaseUrl).catch(() => "");
    phase("durability", "ok", `SESSION_STORE=postgres RUN_STORE=postgres (${grants} durable grant(s))`);
  } else {
    phase("durability", "ok", "memory stores");
  }
  durability = { sessionStore, runStore, databaseUrl };

  completeDevSecuritySecrets(assembled.env, databaseUrl || worktree);
  const portalSessionSecret = assembled.env.PORTAL_SESSION_SECRET!;
  let portalDevPrincipal = assembled.env.DEV_INSTANCE_ADMIN_PRINCIPAL || "";
  if (!portalDevPrincipal && adminGrantsSeed) portalDevPrincipal = adminGrantsSeed.split(":")[0] ?? "";
  if (!portalDevPrincipal && durableAdminPrincipal) portalDevPrincipal = durableAdminPrincipal;
  if (!portalDevPrincipal) portalDevPrincipal = assembled.env.USER || "dev-admin";
  log(`portal auth: localhost bypass signs in as ${portalDevPrincipal}`);

  const tokens = slackOn(spec) ? slotTokens(slot, store) : null;

  return {
    worktree,
    ports,
    baseEnv: assembled.env,
    watch: spec.watch,
    webUiBasePath: spec.callerEnv.DEV_INSTANCE_WEB_UI_BASE || "/",
    ...(tokens ? { slack: { botToken: tokens.botToken, appToken: tokens.appToken } } : {}),
    sessionStore,
    runStore,
    databaseUrl,
    adminGrantsSeed,
    coreSigningSecret: assembled.env.CORE_SIGNING_SECRET || "",
    portalSessionSecret,
    portalDevPrincipal,
    sandboxEnv: sandbox.env,
  };
}

async function startChildren(inputs: SpecInputs): Promise<{ ok: boolean; failedChild?: ChildName; detail?: string }> {
  const specs = buildChildSpecs(inputs);
  for (const spec of specs) {
    phase(spec.name, "start");
    let child = children.get(spec.name);
    if (child) child.update(spec);
    else {
      child = new Child(spec, lock, log, () => {});
      children.set(spec.name, child);
    }
    const res = await child.start();
    if (!res.ok) {
      phase(spec.name, "fail", res.detail);
      return { ok: false, failedChild: spec.name, detail: res.detail };
    }
    phase(spec.name, "ok");
  }
  return { ok: true };
}

async function boot(): Promise<void> {
  const spec = readBootSpec();
  watch = spec.watch;
  bootId = randomUUID();
  try {
    writeLegacyMeta(true);
    persistState();
    specInputs = await assembleAndPrepare(spec);
    currentEnvSha = computeEnvSha(specInputs.baseEnv);
    currentGitSha = gitHead(worktree);
    const started = await startChildren(specInputs);
    if (!started.ok) {
      bootResult = {
        ok: false,
        reason: `${started.failedChild} failed to start: ${started.detail}`,
        slot,
        failedChild: started.failedChild,
        logTail: started.failedChild ? logTail(started.failedChild) : [],
      };
      finishBoot();
      await teardown("boot failed");
      process.exit(EXIT.childFailed);
    }
    phase("verify", "start");
    let verified: { ok: boolean; result: Partial<BootResult> } = { ok: true, result: {} };
    if (slackOn(spec)) {
      await resolveCanaryChannel(spec);
      verified = await verifySlack(spec);
      if (!verified.ok) {
        bootResult = { ok: false, slackEnabled: true, slot, ...verified.result } as BootResult;
        phase("verify", "fail", bootResult.reason);
        finishBoot();
        await teardown(`verification failed: ${bootResult.reason}`);
        process.exit(bootResult.reason === "slot-stolen" ? EXIT.slotStolen : EXIT.verificationFailed);
      }
      phase(
        "verify",
        "ok",
        verified.result.canary
          ? `canary ${verified.result.canary.rttMs}ms, connections=1`
          : "socket verified (no canary channel)",
      );
    } else {
      phase("verify", "ok", "Slack off -- nothing to verify");
    }
    bootedAt = nowEpoch();
    bootResult = { ok: true, slackEnabled: slackOn(spec), slot, handle, ...verified.result } as BootResult;
    writeLegacyMeta(false);
    persistState();
    finishBoot();
    startLoops();
    log(slackOn(spec) ? `live -- @${handle} on slot ${slot}` : `live -- browser only (Slack off) on slot ${slot}`);
  } catch (err) {
    bootResult = { ok: false, reason: errMessage(err), slot };
    phase(phaseName, "fail", errMessage(err));
    finishBoot();
    await teardown(`boot error: ${errMessage(err)}`);
    process.exit(EXIT.missingPrereq);
  }
}

function finishBoot(): void {
  bootDone = true;
  emit({ event: "done", result: bootResult ?? undefined });
}

function startLoops(): void {
  const heartbeat = setInterval(() => {
    if (!existsSync(lock)) {
      log("lease directory vanished (external teardown) -- exiting");
      void shutdownSelf(false);
      return;
    }
    writeHeartbeat(lock, bootResult?.ok ? "live" : "degraded");
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  writeHeartbeat(lock, "live");

  const health = setInterval(async () => {
    for (const [name, child] of children) {
      const ok = await child.probeHealth();
      const fails = ok ? 0 : (healthFails.get(name) ?? 0) + 1;
      healthFails.set(name, fails);
      if (child.state === "healthy" && fails >= HEALTH_FAIL_THRESHOLD) {
        child.state = "unhealthy";
        log(`${name} unhealthy (${fails} consecutive probe failures)`);
      } else if (child.state === "unhealthy" && ok) {
        child.state = "healthy";
        log(`${name} healthy again`);
      }
    }
    const slackHealth = slackOn(readBootSpec()) ? await fetchSlackHealth() : null;
    if (slackHealth) {
      if (slackHealth.lastActivityAt) {
        lastSlackActivitySec = Math.max(lastSlackActivitySec, Math.floor(slackHealth.lastActivityAt / 1000));
      }
      if ((slackHealth.numConnections ?? 1) > 1 && (lastSlackHealth?.numConnections ?? 1) <= 1) {
        log(
          `DEGRADED: num_connections=${slackHealth.numConnections} -- another connection to this Slack app is stealing events (host: ${slackHealth.helloHost ?? "?"})`,
        );
      }
      lastSlackHealth = slackHealth;
    }
  }, HEALTH_INTERVAL_MS);
  health.unref();

  if (CANARY_INTERVAL_MS > 0 && slackOn(readBootSpec())) {
    const canary = setInterval(async () => {
      if (!canaryChannel) await resolveCanaryChannel(readBootSpec());
      if (!canaryChannel) return;
      const res = await runCanary(canaryChannel);
      if (!res.ok) log(`periodic canary FAILED: ${res.reason} -- event delivery is broken (run 'dev doctor')`);
    }, CANARY_INTERVAL_MS);
    canary.unref();
  }

  if (IDLE_HOURS > 0) {
    const idle = setInterval(async () => {
      const lastActivity = Math.max(bootedAt ?? startedAt, lastSlackActivitySec, lastControlAt);
      const idleSec = nowEpoch() - lastActivity;
      if (idleSec > IDLE_HOURS * 3600) {
        log(
          `idle self-teardown: no Slack events or control actions for ${Math.floor(idleSec / 3600)}h (limit ${IDLE_HOURS}h; set DEV_INSTANCE_IDLE_HOURS=0 to disable)`,
        );
        await shutdownSelf(true);
      }
    }, 10 * 60_000);
    idle.unref();
  }
}

async function teardown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`teardown: ${reason}`);
  for (const name of [...CHILD_ORDER].reverse()) {
    const child = children.get(name);
    if (child) await child.stop();
  }
  for (const aux of ["tunnel.pid"]) {
    const pid = readPidFile(lock, aux);
    if (pid) await killTree(pid, 3000);
  }
  if (sandbox?.backend === "local") await destroyLocalDevSandboxes(log);
}

async function shutdownSelf(removeLock: boolean): Promise<void> {
  await teardown("shutdown requested");
  if (removeLock) rmSync(lock, { recursive: true, force: true });
  process.exit(EXIT.ok);
}

let socketPathResolved = join(lock, "supervisor.sock");
if (socketPathResolved.length > 100) socketPathResolved = join(tmpdir(), `qm-dev-${slot}.sock`);

function serveApi(): Server {
  const server = createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/status") {
        respond(200, await statusReport());
        return;
      }
      if (req.method === "GET" && req.url === "/boot-events") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (const e of events) res.write(JSON.stringify(e) + "\n");
        if (bootDone) {
          res.end();
          return;
        }
        const sub = (e: BootPhaseEvent) => {
          res.write(JSON.stringify(e) + "\n");
          if (e.event === "done") {
            subscribers.delete(sub);
            res.end();
          }
        };
        subscribers.add(sub);
        req.on("close", () => subscribers.delete(sub));
        return;
      }
      const body = await readBody(req);
      if (req.method === "POST") lastControlAt = nowEpoch();
      if (req.method === "POST" && req.url === "/reload") {
        respond(200, await reload(body));
        return;
      }
      if (req.method === "POST" && req.url === "/restart") {
        const names = (body.children as ChildName[] | undefined) ?? [...children.keys()];
        const results: Record<string, unknown> = {};
        for (const name of CHILD_ORDER.filter((n) => names.includes(n))) {
          const child = children.get(name);
          results[name] = child ? await child.restart() : { ok: false, detail: "unknown child" };
        }
        respond(200, { ok: Object.values(results).every((r) => (r as { ok: boolean }).ok), results });
        return;
      }
      if (req.method === "POST" && req.url === "/canary") {
        if (!canaryChannel) await resolveCanaryChannel(readBootSpec());
        const channel = String(body.channel || canaryChannel || "");
        respond(200, channel ? await runCanary(channel) : { ok: false, reason: "no canary channel configured" });
        return;
      }
      if (req.method === "POST" && req.url === "/shutdown") {
        respond(200, { ok: true });
        setTimeout(() => void shutdownSelf(true), 50);
        return;
      }
      respond(404, { ok: false, reason: "not found" });
    } catch (err) {
      respond(500, { ok: false, reason: errMessage(err) });
    }
  });
  rmSync(socketPathResolved, { force: true });
  server.listen(socketPathResolved);
  return server;
}

async function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

async function reload(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const spec = readBootSpec();
  const callerEnv = (body.callerEnv as Record<string, string> | undefined) ?? spec.callerEnv;
  const force = body.force === true;
  const dryRun = body.dryRun === true;
  const freshCanary = slackOn(spec)
    ? slotTokens(slot, store).canaryChannel || callerEnv.DEV_INSTANCE_CANARY_CHANNEL || spec.canaryChannel || ""
    : "";
  const newSpec: BootSpec = { ...spec, callerEnv, canaryChannel: freshCanary };
  if (dryRun) {
    const assembled = await assembleEnv({
      worktree,
      callerEnv,
      allowMock: callerEnv.DEV_INSTANCE_ALLOW_MOCK === "1",
      log,
    });
    const dryEnvSha = computeEnvSha(assembled.env);
    const allHealthy =
      children.size === CHILD_ORDER.length && [...children.values()].every((c) => c.state === "healthy");
    return {
      ok: true,
      noop: dryEnvSha === currentEnvSha && allHealthy,
      envSha: dryEnvSha,
      gitSha: gitHead(worktree),
      bootId,
      dryRun: true,
    };
  }
  writeFileSync(join(lock, "boot-spec.json"), JSON.stringify(newSpec, null, 2), { mode: 0o600 });
  const inputs = await assembleAndPrepare(newSpec);
  const newEnvSha = computeEnvSha(inputs.baseEnv);
  const newGitSha = gitHead(worktree);
  const noopEligible =
    newEnvSha === currentEnvSha &&
    children.size === CHILD_ORDER.length &&
    [...children.values()].every((c) => c.state === "healthy");
  if (!force && noopEligible) {
    return {
      ok: true,
      noop: true,
      envSha: newEnvSha,
      gitSha: newGitSha,
      bootId,
      detail: "env unchanged and all children healthy -- nothing restarted (use --force to restart anyway)",
    };
  }
  specInputs = inputs;
  currentEnvSha = newEnvSha;
  currentGitSha = newGitSha;
  bootId = randomUUID();
  const specs = buildChildSpecs(inputs);
  for (const childSpec of specs) {
    const child = children.get(childSpec.name);
    if (!child) continue;
    child.update(childSpec);
    const res = await child.restart();
    if (!res.ok)
      return {
        ok: false,
        reason: `${childSpec.name} failed to restart: ${res.detail}`,
        logTail: logTail(childSpec.name),
      };
  }
  let verified: { ok: boolean; result: Partial<BootResult> } = { ok: true, result: {} };
  if (slackOn(newSpec)) {
    await resolveCanaryChannel(newSpec);
    verified = await verifySlack(newSpec);
    if (!verified.ok) return { ok: false, reason: verified.result.reason, ...verified.result };
  }
  bootedAt = nowEpoch();
  writeLegacyMeta(false);
  persistState();
  return {
    ok: true,
    noop: false,
    slackEnabled: slackOn(newSpec),
    envSha: newEnvSha,
    gitSha: newGitSha,
    bootId,
    handle,
    ...verified.result,
  };
}

async function statusReport(): Promise<StatusReport> {
  const childStatuses: StatusReport["children"] = {};
  for (const [name, child] of children) {
    childStatuses[name] = child.status();
  }
  const slackEnabled = slackOn(readBootSpec());
  const slackHealth = slackEnabled ? await fetchSlackHealth() : null;
  if (slackHealth && childStatuses.core) childStatuses.core.slack = slackHealth;
  return {
    slot,
    state: bootState(),
    worktree,
    branch: currentBranch(worktree),
    handle,
    ports,
    canary: { channel: canaryChannel, source: canaryChannelSource },
    supervisor: { pid: process.pid, startedAt, uptimeSec: nowEpoch() - startedAt },
    bootedAt,
    envSha: currentEnvSha,
    gitSha: currentGitSha,
    sandbox: sandbox ? { backend: sandbox.backend, detail: sandbox.detail } : { backend: "none", detail: "" },
    durability: {
      sessionStore: durability.sessionStore,
      runStore: durability.runStore,
      databaseUrl: Boolean(durability.databaseUrl),
    },
    harness,
    slackEnabled,
    watch,
    turnsLive: harness !== "mock",
    publicApiUrl: sandbox?.publicApiUrl ?? null,
    children: childStatuses,
  };
}

function bootPhase(): "booting" | "live" | "failed" {
  if (!bootDone) return "booting";
  return bootResult?.ok ? "live" : "failed";
}

function bootState(): "booting" | "live" | "degraded" | "down" {
  if (!bootDone) return "booting";
  return bootResult?.ok ? liveOrDegraded() : "down";
}

function liveOrDegraded(): "live" | "degraded" {
  const allHealthy = children.size > 0 && [...children.values()].every((c) => c.state === "healthy");
  const conns = lastSlackHealth?.numConnections ?? 1;
  return allHealthy && conns <= 1 ? "live" : "degraded";
}

process.on("SIGTERM", () => void shutdownSelf(true));
process.on("SIGINT", () => void shutdownSelf(true));
process.on("uncaughtException", (err) => {
  log(`uncaught: ${err.stack || err.message}`);
});
process.on("unhandledRejection", (err) => {
  log(`unhandled rejection: ${errMessage(err)}`);
});

writePidFile(lock, "supervisor.pid", process.pid);
writeHeartbeat(lock, "booting");
serveApi();
persistState();
void boot();
