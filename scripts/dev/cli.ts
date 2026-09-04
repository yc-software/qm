import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ensureStore,
  listSlots,
  poolStore,
  readSlotFlag,
  slotFlagged,
  slotPorts,
  slotTokens,
  slotValid,
  writeSlotFlag,
} from "./lib/pool.ts";
import {
  claimSlotLock,
  heartbeatFresh,
  leaseReclaimReason,
  leaseStale,
  leaseStartedEpoch,
  listLeases,
  lockDir,
  myLease,
  readMeta,
  readPidFile,
  releaseSlotLock,
  supervisorAlive,
  takenSummary,
} from "./lib/lease.ts";
import { callerEnvSnapshot, currentBranch, repoRoot } from "./lib/envctx.ts";
import { killTree, pidAlive, portHolders, spawnDetached } from "./lib/proc.ts";
import {
  resolveSocketPath,
  streamBootEvents,
  supervisorReachable,
  supervisorRequest,
  waitForSupervisor,
} from "./lib/client.ts";
import { sweepSlackTokenOrphans } from "./lib/orphans.ts";
import { destroyLocalDevSandboxes } from "./lib/sandbox.ts";
import { bestEffort, errMessage, formatAge, nowEpoch, sleep } from "./lib/util.ts";
import { runDoctor } from "./commands/doctor.ts";
import type { BootPhaseEvent, BootResult, LeaseInfo } from "./lib/types.ts";
import { CHILD_ORDER, EXIT } from "./lib/types.ts";
import { validOrgId } from "../../cli/src/config.ts";

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: true,
      tokens: true,
      options: {
        json: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        rotate: { type: "boolean", default: false },
        follow: { type: "boolean", short: "f", default: false },
        fix: { type: "boolean", default: false },
        sandbox: { type: "string", default: "auto" },
        "no-slack": { type: "boolean", default: false },
        "no-watch": { type: "boolean", default: false },
        org: { type: "string" },
      },
    });
  } catch (error) {
    console.error(`dev: ${errMessage(error)}`);
    process.exit(EXIT.usage);
  }
}

const { values: opts, positionals, tokens } = parseCli();

const command = positionals[0] ?? "up";
const store = poolStore();

const commandOptions: Record<string, readonly string[]> = {
  up: ["json", "force", "strict", "rotate", "sandbox", "no-slack", "no-watch", "org"],
  down: ["json"],
  status: ["json"],
  restart: ["json"],
  canary: ["json"],
  logs: ["follow"],
  doctor: ["json", "fix", "no-slack"],
};

const devServiceNames = [...CHILD_ORDER, "web-ui"];

const allowedOptions = commandOptions[command];
if (allowedOptions) {
  const unsupported = tokens.find((token) => token.kind === "option" && !allowedOptions.includes(token.name));
  if (unsupported?.kind === "option") {
    console.error(`dev: ${command} does not support ${unsupported.rawName}`);
    process.exit(EXIT.usage);
  }
  if (command !== "restart" && command !== "logs" && positionals.length > 1) {
    console.error(`dev: unexpected argument: ${JSON.stringify(positionals[1])}`);
    process.exit(EXIT.usage);
  }
  if (command === "restart" || command === "logs") {
    const names = command === "logs" ? [...devServiceNames, "supervisor"] : devServiceNames;
    const invalid = positionals.slice(1).find((name) => !names.includes(name));
    if (invalid) {
      console.error(`dev: unknown service ${JSON.stringify(invalid)} (use one of: ${names.join(", ")})`);
      process.exit(EXIT.usage);
    }
  }
}

function out(msg: string): void {
  if (!opts.json) console.log(msg);
}

function emitJson(payload: unknown): void {
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
}

const orgId = opts.org ?? process.env.DEV_INSTANCE_ORG_ID ?? "acme";
const withSlack = !opts["no-slack"] && process.env.DEV_INSTANCE_NO_SLACK !== "1";
const devCallerEnv = (): Record<string, string> => ({ ...callerEnvSnapshot(), DEV_INSTANCE_ORG_ID: orgId });

async function legacyTeardown(lease: LeaseInfo): Promise<void> {
  for (const name of ["portal", "admin", "web", "web-build", "slack", "core", "tunnel", "supervisor"]) {
    const pid = readPidFile(lease.lockDir, `${name}.pid`);
    if (pid) await killTree(pid, 5000);
  }
  await destroyLocalDevSandboxes((m) => out(m)).catch(() => undefined);
  releaseSlotLock(lease.slot, store);
}

async function teardownLease(lease: LeaseInfo): Promise<void> {
  const sock = resolveSocketPath(lease.lockDir);
  if (await supervisorReachable(sock)) {
    await supervisorRequest(sock, "POST", "/shutdown", {}).catch(() => {});
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && existsSync(lease.lockDir)) await sleep(300);
    if (!existsSync(lease.lockDir)) return;
  }
  await legacyTeardown(lease);
}

async function reapStale(): Promise<void> {
  for (const lease of listLeases(store)) {
    if (leaseStale(lease)) {
      out(`reaping stale lease ${lease.slot} (was: ${lease.meta.worktree ?? "?"})`);
      await teardownLease(lease);
    }
  }
}

async function reclaimReclaimable(): Promise<boolean> {
  for (const lease of listLeases(store)) {
    const reason = leaseReclaimReason(lease);
    if (reason) {
      out(`reclaiming occupied ${lease.slot}: ${reason}`);
      await teardownLease(lease);
      return true;
    }
  }
  return false;
}

function claimNext(exclude: Set<string>): string | null {
  const slots = listSlots(store);
  const ordered = [...slots.filter((s) => !slotFlagged(s, store)), ...slots.filter((s) => slotFlagged(s, store))];
  for (const slot of ordered) {
    if (exclude.has(slot)) continue;
    if (!claimSlotLock(slot, store)) continue;
    if (!slotValid(slot, store)) {
      releaseSlotLock(slot, store);
      out(`skip ${slot}: tokens missing/invalid in ${join(store, `${slot}.env`)}`);
      exclude.add(slot);
      continue;
    }
    return slot;
  }
  return null;
}

// Slackless instances need only a port/lock slot, not a provisioned Slack app.
// Prefer slot numbers with no poolN.env so a browser-only instance never squats
// a slot a Slack-enabled worktree could use; fall back to configured ones.
const MAX_PORT_SLOTS = 16; // slotPorts spaces port families 16 apart

function claimPortSlot(exclude: Set<string>): string | null {
  const configured = new Set(listSlots(store));
  const all = Array.from({ length: MAX_PORT_SLOTS }, (_, i) => `pool${i + 1}`);
  const ordered = [...all.filter((s) => !configured.has(s)), ...all.filter((s) => configured.has(s))];
  for (const slot of ordered) {
    if (exclude.has(slot)) continue;
    if (claimSlotLock(slot, store)) return slot;
  }
  return null;
}

function renderPhase(e: BootPhaseEvent): void {
  if (opts.json || e.event !== "phase") return;
  let mark = "…";
  if (e.state === "ok") mark = "✓";
  else if (e.state === "fail") mark = "✗";
  else if (e.state === "warn") mark = "!";
  if (e.state === "start") return;
  console.log(`  ${mark} ${e.name}${e.detail ? ` -- ${e.detail}` : ""}`);
}

async function bootOnSlot(slot: string, worktree: string, branch: string): Promise<BootResult> {
  const ports = slotPorts(slot);
  const lock = lockDir(slot, store);
  const tokens = withSlack ? slotTokens(slot, store) : null;

  writeFileSync(
    join(lock, "meta"),
    [
      `slot=${slot}`,
      `worktree=${worktree}`,
      `branch=${branch}`,
      `port=${ports.core}`,
      `web_port=${ports.web}`,
      `admin_port=${ports.admin}`,
      `portal_port=${ports.portal}`,
      `slack=${withSlack ? "1" : "0"}`,
      "booting=1",
      `owner_pid=${process.pid}`,
      `created_epoch=${nowEpoch()}`,
      `created=${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
      "",
    ].join("\n"),
  );

  if (tokens) {
    const swept = tokens?.appToken
      ? await sweepSlackTokenOrphans(tokens.appToken, new Set(), (m) => out(m))
      : { swept: [] as string[] };
    if (swept.swept.length) out(`swept ${swept.swept.length} orphaned process(es) holding ${slot}'s Slack app token`);
  }

  const callerEnv = devCallerEnv();
  const canaryChannel = (tokens?.canaryChannel ?? "") || callerEnv.DEV_INSTANCE_CANARY_CHANNEL || "";
  writeFileSync(
    join(lock, "boot-spec.json"),
    JSON.stringify(
      {
        slot,
        worktree,
        branch,
        callerEnv,
        watch: !opts["no-watch"] && callerEnv.DEV_INSTANCE_WATCH !== "0",
        sandbox: opts.sandbox as "local" | "sprites" | "smolmachines" | "auto",
        canaryChannel,
        strict: opts.strict,
        slack: withSlack,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const supervisorScript = join(worktree, "scripts/dev/supervisor/main.ts");
  spawnDetached({
    cwd: worktree,
    logFile: join(lock, "supervisor.log"),
    argv: ["node", supervisorScript, "--slot", slot, "--worktree", worktree, "--store", store],
    env: callerEnv,
  });

  const sock = resolveSocketPath(lock);
  if (!(await waitForSupervisor(sock, 60_000))) {
    let tail: string[] = [];
    bestEffort(() => {
      tail = readFileSync(join(lock, "supervisor.log"), "utf8").trimEnd().split("\n").slice(-15);
    });
    const supPid = readPidFile(lock, "supervisor.pid");
    if (supPid) await killTree(supPid, 5000);
    return {
      ok: false,
      reason: `supervisor never came up on ${slot} (killed pid ${supPid ?? "?"} so it cannot linger)`,
      slot,
      logTail: tail,
    };
  }

  out(
    tokens
      ? `booting on slot ${slot} (@${tokens.handle || `agent-${slot}`})...`
      : `booting on slot ${slot} (Slack off -- browser only)...`,
  );
  let result: BootResult | null = null;
  await streamBootEvents(sock, (e) => {
    renderPhase(e);
    if (e.event === "done" && e.result) result = e.result;
  }).catch(() => {});
  return result ?? { ok: false, reason: "boot event stream ended without a result", slot };
}

function printSuccess(result: BootResult, branch: string): void {
  const ports = slotPorts(result.slot);
  const lock = lockDir(result.slot, store);
  const meta = readMeta(lock);
  out("");
  const slackLive = result.slackEnabled !== false;
  out(
    slackLive
      ? `[ok] dev instance up -- slot ${result.slot} (VERIFIED: socket exclusive${result.canary ? `, canary ${result.canary.rttMs}ms round trip` : ", delivery unverified -- no canary channel"})`
      : `[ok] dev instance up -- slot ${result.slot} (browser only -- Slack off)`,
  );
  out(`   branch : ${branch}`);
  out(`   portal : http://localhost:${ports.portal}  -> prod-style front door: the assistant at / and /admin`);
  out(
    `   core   : http://localhost:${ports.core}  (org=${orgId}, session_store=${meta.session_store}, run_store=${meta.run_store})`,
  );
  if (slackLive) out(`   slack  : @${result.handle}  -> mention it in example.slack.com to test`);
  out(`   web    : http://localhost:${ports.portal}/  (direct: http://localhost:${ports.web})`);
  out(`   admin  : http://localhost:${ports.portal}/admin/   (direct: http://localhost:${ports.admin})`);
  out(`   logs   : ${lock}/{core,web,admin,portal,supervisor}.log`);
  out(`   status : dev status   |   diagnose: dev doctor   |   apply env/code changes: dev up (reloads in place)`);
  out(`   down   : dev down   (auto-reaped if this worktree is removed)`);
}

async function cmdUp(): Promise<number> {
  ensureStore(store);
  const worktree = repoRoot();
  const branch = currentBranch(worktree);
  await reapStale();

  const mine = myLease(worktree, store);
  if (mine) {
    const sock = resolveSocketPath(mine.lockDir);
    if (await supervisorReachable(sock)) {
      if (opts.rotate) {
        out(`rotating away from ${mine.slot}...`);
        writeSlotFlag(mine.slot, { reason: "manual rotate", at: nowEpoch() }, store);
        await teardownLease(mine);
      } else {
        out(`slot ${mine.slot} is live for this worktree -- reloading with fresh env...`);
        const res = await supervisorRequest(
          sock,
          "POST",
          "/reload",
          { callerEnv: devCallerEnv(), force: opts.force },
          300_000,
        );
        emitJson(res.body);
        if (res.body.noop) out(`[ok] ${res.body.detail}`);
        else if (res.body.ok)
          out(`[ok] reloaded with fresh env (envSha ${res.body.envSha}, git ${res.body.gitSha}) -- verified`);
        else out(`[fail] reload: ${res.body.reason}`);
        return res.body.ok ? EXIT.ok : EXIT.verificationFailed;
      }
    } else if (mine.meta.booting === "1" && pidAlive(Number(mine.meta.owner_pid ?? 0))) {
      out(`an 'up' is already in progress for this worktree (slot ${mine.slot}); not starting another.`);
      return EXIT.ok;
    } else {
      await teardownLease(mine);
    }
  }

  const excluded = new Set<string>();
  const waitMax = Number(process.env.DEV_INSTANCE_WAIT || 120);
  const claim = (): string | null => (withSlack ? claimNext(excluded) : claimPortSlot(excluded));
  for (let attempt = 1; attempt <= 3; attempt++) {
    let slot = claim();
    if (!slot && (await reclaimReclaimable())) slot = claim();
    if (!slot && waitMax > 0 && attempt === 1) {
      out("");
      out(
        withSlack
          ? `all pool apps are in use by other worktrees -- waiting up to ${waitMax}s for a free slot.`
          : `all local slots are in use by other worktrees -- waiting up to ${waitMax}s for a free one.`,
      );
      out(`  this is normal contention, not an error.  held now: ${takenSummary(store)}`);
      let waited = 0;
      while (waited < waitMax && !slot) {
        await sleep(5000);
        waited += 5;
        await reapStale();
        if (await reclaimReclaimable()) slot = claim();
        if (!slot) slot = claim();
      }
    }
    if (!slot) {
      emitJson({ ok: false, reason: "no free pool slot", held: takenSummary(store) });
      out(
        withSlack
          ? `no free pool app. Another worktree holds each one -- 'dev down' one of them, add a poolN.env, or raise DEV_INSTANCE_WAIT.`
          : `no free local slot. 'dev down' another worktree or raise DEV_INSTANCE_WAIT.`,
      );
      return EXIT.noFreeSlot;
    }

    const result = await bootOnSlot(slot, worktree, branch);
    if (result.ok) {
      emitJson(result);
      printSuccess(result, branch);
      return EXIT.ok;
    }

    releaseSlotLock(slot, store);
    if (result.reason === "slot-stolen") {
      writeSlotFlag(
        slot,
        {
          reason: "stolen",
          at: nowEpoch(),
          detail: `num_connections=${result.numConnections} host=${result.helloHost ?? "?"}`,
        },
        store,
      );
      out(
        `[!] slot ${slot} is STOLEN: ${result.numConnections} connections open to its Slack app (another machine/worktree holds one; hello host: ${result.helloHost ?? "?"}).`,
      );
      out(`    flagged ${slot} for 30min and rotating to the next slot...`);
      excluded.add(slot);
      continue;
    }
    if (result.reason === "canary-failed") {
      writeSlotFlag(slot, { reason: "canary-failed", at: nowEpoch(), detail: result.canary?.reason }, store);
      out(`[!] slot ${slot} connected but a posted canary never came back over the socket (${result.canary?.reason}).`);
      out(`    likely a stale Slack app (needs reinstall) -- flagged ${slot}, rotating to the next slot...`);
      excluded.add(slot);
      continue;
    }
    emitJson(result);
    out(`[fail] ${result.reason}`);
    for (const line of result.logTail ?? []) out(`    ${line}`);
    return result.failedChild ? EXIT.childFailed : EXIT.missingPrereq;
  }
  emitJson({ ok: false, reason: "all attempted slots failed verification" });
  out(
    "[fail] every attempted slot failed verification -- run 'dev doctor' and check the flagged slots (poolN.flag.json).",
  );
  return EXIT.slotStolen;
}

async function cmdDown(): Promise<number> {
  ensureStore(store);
  const worktree = repoRoot();
  const mine = myLease(worktree, store);
  if (!mine) {
    out("nothing to tear down for this worktree.");
    await reapStale();
    return EXIT.ok;
  }
  const slot = mine.slot;
  const tokens = mine.meta.slack === "0" ? null : slotTokens(slot, store);
  await teardownLease(mine);
  const residue: string[] = [];
  for (const [name, port] of Object.entries(slotPorts(slot))) {
    if (name === "supervisor" || name === "prodProxy") continue;
    const holders = portHolders(port);
    if (holders.length) residue.push(`port ${port} (${name}) still held by pid(s) ${holders.join(",")}`);
  }
  const swept = tokens
    ? await sweepSlackTokenOrphans(tokens.appToken, new Set(), (m) => out(m))
    : { swept: [] as string[] };
  if (residue.length) {
    emitJson({ ok: false, slot, residue });
    out(`[!] down completed with residue:\n  ${residue.join("\n  ")}`);
    return EXIT.internal;
  }
  emitJson({ ok: true, slot, sweptOrphans: swept.swept.length });
  out(
    `[ok] down -- released slot ${slot} for this worktree (ports verified free${swept.swept.length ? `; swept ${swept.swept.length} orphan(s)` : ""}).`,
  );
  return EXIT.ok;
}

async function cmdStatus(): Promise<number> {
  ensureStore(store);
  const worktree = (() => {
    try {
      return repoRoot();
    } catch {
      return "";
    }
  })();
  const rows: Record<string, unknown>[] = [];
  const leases = listLeases(store);
  const known = [...new Set([...listSlots(store), ...leases.map((l) => l.slot)])].sort(
    (a, b) => Number(a.replace(/^pool/, "")) - Number(b.replace(/^pool/, "")),
  );
  for (const slot of known) {
    const lock = lockDir(slot, store);
    const ports = slotPorts(slot);
    const flag = readSlotFlag(slot, store);
    if (!existsSync(lock)) {
      rows.push({ slot, state: flag && slotFlagged(slot, store) ? `flagged(${flag.reason})` : "free", ports });
      continue;
    }
    const lease = leases.find((l) => l.slot === slot);
    if (!lease) continue;
    const sock = resolveSocketPath(lock);
    if (await supervisorReachable(sock)) {
      const res = await supervisorRequest(sock, "GET", "/status", undefined, 5000).catch(() => null);
      if (res?.body) {
        rows.push({ ...res.body, mine: res.body.worktree === worktree, flag });
        continue;
      }
    }
    const meta = lease.meta;
    const alive = CHILD_ORDER.filter((n) => pidAlive(readPidFile(lock, `${n}.pid`)));
    let state = "dead";
    if (leaseStale(lease)) state = "stale";
    else if (meta.booting === "1") state = "booting";
    else if (alive.length === CHILD_ORDER.length) state = "up(legacy)";
    else if (alive.length) state = "partial";
    rows.push({
      slot,
      state,
      ports,
      worktree: meta.worktree,
      branch: meta.branch,
      mine: meta.worktree === worktree,
      ageSec: nowEpoch() - leaseStartedEpoch(lease),
      supervised: supervisorAlive(lease),
      heartbeatFresh: heartbeatFresh(lease),
      childrenAlive: alive,
      flag,
    });
  }
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return EXIT.ok;
  }
  console.log(
    [
      "SLOT".padEnd(7),
      "STATE".padEnd(18),
      "PORTS".padEnd(21),
      "AGE".padEnd(8),
      "MINE".padEnd(5),
      "BRANCH".padEnd(28),
      "WORKTREE",
    ].join(" "),
  );
  for (const r of rows) {
    const ports = r.ports as ReturnType<typeof slotPorts>;
    let flagSuffix = "";
    if (r.flag && String(r.state) !== "free") flagSuffix = "+flag";
    const state = String(r.state) + flagSuffix;
    let age = "";
    if (r.ageSec !== undefined) age = formatAge(Number(r.ageSec));
    else if (r.supervisor) age = formatAge(Number((r.supervisor as { uptimeSec: number }).uptimeSec));
    console.log(
      [
        String(r.slot).padEnd(7),
        state.padEnd(18),
        `${ports.core}/${ports.web}/${ports.admin}/${ports.portal}`.padEnd(21),
        age.padEnd(8),
        (r.mine ? "this" : "").padEnd(5),
        String(r.branch ?? "-").padEnd(28),
        String(r.worktree ?? "(available)"),
      ].join(" "),
    );
  }
  const taken = rows.filter((r) => r.state !== "free" && !String(r.state).startsWith("flagged")).length;
  console.log("");
  console.log(`${taken} taken / ${rows.length - taken} free / ${rows.length} slots total`);
  console.log("live = supervised + verified. Reclaim never touches a slot with a fresh supervisor heartbeat.");
  return EXIT.ok;
}

async function withMySupervisor<T>(fn: (sock: string, lease: LeaseInfo) => Promise<T>): Promise<T> {
  const worktree = repoRoot();
  const mine = myLease(worktree, store);
  if (!mine) throw new Error("no dev instance is up for this worktree (run 'dev up')");
  const sock = resolveSocketPath(mine.lockDir);
  if (!(await supervisorReachable(sock)))
    throw new Error(
      `supervisor for ${mine.slot} is unreachable (legacy or dead instance -- run 'dev down' then 'dev up')`,
    );
  return await fn(sock, mine);
}

const supervisorChildNames = (names: string[]): string[] => [
  ...new Set(names.map((name) => (name === "web-ui" ? "web" : name))),
];

async function cmdRestart(): Promise<number> {
  const children = supervisorChildNames(positionals.slice(1));
  const res = await withMySupervisor((sock) =>
    supervisorRequest(sock, "POST", "/restart", { children: children.length ? children : undefined }, 180_000),
  );
  emitJson(res.body);
  out(
    res.body.ok
      ? `[ok] restarted ${children.length ? children.join(",") : "all children"}`
      : `[fail] ${JSON.stringify(res.body.results)}`,
  );
  return res.body.ok ? EXIT.ok : EXIT.childFailed;
}

async function cmdCanary(): Promise<number> {
  const res = await withMySupervisor((sock) => supervisorRequest(sock, "POST", "/canary", {}, 40_000));
  emitJson(res.body);
  out(
    res.body.ok
      ? `[ok] canary round trip ${res.body.rttMs}ms -- event delivery verified`
      : `[fail] canary: ${res.body.reason}`,
  );
  return res.body.ok ? EXIT.ok : EXIT.verificationFailed;
}

async function cmdLogs(): Promise<number> {
  const worktree = repoRoot();
  const mine = myLease(worktree, store);
  if (!mine) {
    out("no dev instance for this worktree.");
    return EXIT.ok;
  }
  const names = positionals.length > 1 ? supervisorChildNames(positionals.slice(1)) : [...CHILD_ORDER, "supervisor"];
  const files = names.map((n) => join(mine.lockDir, `${n}.log`)).filter((f) => existsSync(f));
  if (opts.follow) {
    const child = spawn("tail", ["-f", ...files], { stdio: "inherit" });
    await new Promise((resolve) => child.on("exit", resolve));
    return EXIT.ok;
  }
  for (const f of files) {
    console.log(`=== ${f} ===`);
    console.log(readFileSync(f, "utf8").trimEnd().split("\n").slice(-40).join("\n"));
  }
  return EXIT.ok;
}

async function main(): Promise<number> {
  if (!validOrgId(orgId)) {
    console.error("dev: --org must be a lowercase DNS label (a-z, 0-9, and hyphens between)");
    return EXIT.usage;
  }
  switch (command) {
    case "up":
      return await cmdUp();
    case "down":
      return await cmdDown();
    case "status":
      return await cmdStatus();
    case "restart":
      return await cmdRestart();
    case "canary":
      return await cmdCanary();
    case "logs":
      return await cmdLogs();
    case "doctor":
      return await runDoctor({ json: opts.json, fix: opts.fix, store, slack: withSlack });
    default:
      console.error(
        "usage: dev [up|down|status|restart|canary|logs|doctor] [--json] [--force] [--rotate] [--strict] [--sandbox local|sprites|smolmachines|auto] [--no-slack] [--no-watch] [--org id] [--fix]",
      );
      return EXIT.usage;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`dev: ${errMessage(err)}`);
    process.exit(EXIT.internal);
  });
