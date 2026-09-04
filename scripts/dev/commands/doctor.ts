import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { listSlots, readSlotFlag, slotFlagged, slotPorts } from "../lib/pool.ts";
import { heartbeatFresh, leaseStale, listLeases, myLease, supervisorAlive } from "../lib/lease.ts";
import { callerEnvSnapshot, gitHead, repoRoot } from "../lib/envctx.ts";
import { portHolders } from "../lib/proc.ts";
import { resolveSocketPath, supervisorReachable, supervisorRequest } from "../lib/client.ts";
import { EXIT, CHILD_ORDER } from "../lib/types.ts";
import type { StatusReport } from "../lib/types.ts";

interface Check {
  id: string;
  ok: boolean;
  severity: "critical" | "warn" | "info";
  detail: string;
  remedy?: string;
  autoFixable?: boolean;
}

export async function runDoctor(opts: { json: boolean; fix: boolean; store: string; slack: boolean }): Promise<number> {
  const checks: Check[] = [];
  const worktree = (() => {
    try {
      return repoRoot();
    } catch {
      return "";
    }
  })();

  const mine = worktree ? myLease(worktree, opts.store) : null;
  // A browser-only instance (--no-slack, or a live lease booted that way) needs no pool app.
  const needsPool = opts.slack && mine?.meta.slack !== "0";
  const slots = listSlots(opts.store);
  let poolDetail = "Slack off -- no pool slot needed";
  if (needsPool) {
    poolDetail = slots.length ? `${slots.length} pool slot(s) configured` : "no poolN.env files in the pool store";
  }
  checks.push({
    id: "pool",
    ok: !needsPool || slots.length > 0,
    severity: needsPool ? "critical" : "info",
    detail: poolDetail,
    remedy: needsPool && !slots.length ? "add poolN.env files (see the dev-instance skill runbook)" : undefined,
  });

  for (const slot of needsPool ? slots : []) {
    const flag = readSlotFlag(slot, opts.store);
    if (flag && slotFlagged(slot, opts.store)) {
      checks.push({
        id: `slot-flag:${slot}`,
        ok: false,
        severity: "warn",
        detail: `${slot} flagged ${flag.reason} (${flag.detail ?? ""})`,
        remedy:
          flag.reason === "canary-failed"
            ? "the Slack app is likely stale -- rebuild/reinstall it, then delete the flag file"
            : "another connection holds this app; find and kill it, or wait out the 30min flag",
      });
    }
  }

  if (!mine) {
    checks.push({ id: "lease", ok: true, severity: "info", detail: "no dev instance for this worktree" });
  } else {
    const sock = resolveSocketPath(mine.lockDir);
    const reachable = await supervisorReachable(sock);
    checks.push({
      id: "supervisor",
      ok: reachable,
      severity: "critical",
      detail: reachable ? `supervisor live on ${mine.slot}` : `lease held for ${mine.slot} but no supervisor answering`,
      remedy: reachable ? undefined : "dev down && dev up",
      autoFixable: !reachable,
    });
    if (reachable) {
      const status = (await supervisorRequest(sock, "GET", "/status", undefined, 8000)).body as StatusReport;
      for (const name of CHILD_ORDER) {
        const child = status.children[name];
        checks.push({
          id: `child:${name}`,
          ok: child?.state === "healthy",
          severity: "critical",
          detail: child
            ? `${name}: ${child.state} (pid ${child.pid ?? "-"}, restarts ${child.restarts})`
            : `${name}: missing`,
          remedy:
            child?.state === "healthy" ? undefined : `dev restart ${name}  (log: ${join(mine.lockDir, `${name}.log`)})`,
          autoFixable: child?.state !== "healthy",
        });
      }
      if (status.slackEnabled !== false) {
        const slack = status.children.core?.slack;
        const conns = slack?.numConnections ?? null;
        checks.push({
          id: "slack-socket",
          ok: conns === 1,
          severity: "critical",
          detail:
            conns === null
              ? "num_connections unknown (introspection tap degraded)"
              : `num_connections=${conns}${slack?.helloHost ? ` (hello host ${slack.helloHost})` : ""}`,
          remedy:
            conns !== null && conns > 1 ? "another live connection is stealing events: dev up --rotate" : undefined,
        });
        const canary = (await supervisorRequest(sock, "POST", "/canary", {}, 40_000)).body as {
          ok: boolean;
          rttMs?: number;
          reason?: string;
        };
        const unconfigured = !canary.ok && /no canary channel configured/.test(canary.reason ?? "");
        let eventDeliveryRemedy: string | undefined;
        if (!canary.ok) {
          eventDeliveryRemedy = unconfigured
            ? "set CANARY_CHANNEL in the slot env (a channel the bot is in), then dev down && dev up"
            : "events are not arriving: dev up --rotate (stolen/stale app), or check the slack log";
        }
        checks.push({
          id: "event-delivery",
          ok: canary.ok,
          severity: unconfigured ? "warn" : "critical",
          detail: canary.ok ? `canary round trip ${canary.rttMs}ms` : `canary failed: ${canary.reason}`,
          remedy: eventDeliveryRemedy,
        });
      }
      const gitNow = gitHead(worktree);
      checks.push({
        id: "git-drift",
        ok: status.gitSha === gitNow || status.watch,
        severity: "info",
        detail:
          status.gitSha === gitNow
            ? `running HEAD (${gitNow})`
            : `booted at ${status.gitSha}, HEAD is ${gitNow}${status.watch ? " (watch mode reloads code live)" : ""}`,
        remedy: status.gitSha === gitNow || status.watch ? undefined : "dev up  (reloads with current code)",
      });
      const reload = await supervisorRequest(
        sock,
        "POST",
        "/reload",
        { callerEnv: callerEnvSnapshot(), force: false, dryRun: true },
        60_000,
      ).catch(() => null);
      checks.push({
        id: "env-drift",
        ok: reload?.body?.noop !== false,
        severity: "warn",
        detail:
          reload?.body?.noop === false
            ? "environment changed since boot -- children run stale env"
            : `env matches boot (${status.envSha})`,
        remedy: reload?.body?.noop === false ? "dev up  (rolling reload with fresh env)" : undefined,
      });
    }
  }

  for (const lease of listLeases(opts.store)) {
    if (leaseStale(lease)) {
      checks.push({
        id: `stale-lease:${lease.slot}`,
        ok: false,
        severity: "warn",
        detail: `${lease.slot} lease is stale (worktree ${lease.meta.worktree ?? "?"})`,
        remedy: "any 'dev up' reaps it automatically",
        autoFixable: true,
      });
    } else if (lease.heartbeat && !heartbeatFresh(lease) && supervisorAlive(lease)) {
      checks.push({
        id: `wedged:${lease.slot}`,
        ok: false,
        severity: "warn",
        detail: `${lease.slot} supervisor alive but heartbeat stale -- possibly wedged`,
        remedy: `kill ${lease.heartbeat.pid} and re-run dev up`,
      });
    }
  }

  if (worktree) {
    for (const slot of slots) {
      const lease = listLeases(opts.store).find((l) => l.slot === slot);
      if (lease) continue;
      for (const [name, port] of Object.entries(slotPorts(slot))) {
        if (name === "supervisor" || name === "prodProxy" || name === "slackHealth") continue;
        const holders = portHolders(port);
        if (holders.length) {
          checks.push({
            id: `port-squat:${port}`,
            ok: false,
            severity: "warn",
            detail: `free slot ${slot}'s ${name} port ${port} is held by pid(s) ${holders.join(",")}`,
            remedy: `kill ${holders.join(" ")}`,
          });
        }
      }
    }
  }

  const docker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
  checks.push({
    id: "docker-daemon",
    ok: docker,
    severity: "warn",
    detail: docker ? "docker daemon reachable" : "docker daemon unreachable (local Postgres + local sandbox need it)",
    remedy: docker ? undefined : "start Docker Desktop / colima",
  });
  if (worktree) {
    checks.push({
      id: "local-sandbox-code",
      ok: true,
      severity: "info",
      detail: existsSync(join(worktree, "src/sandbox/local-sandbox.ts"))
        ? "worktree supports the local sandbox backend"
        : "worktree predates the local sandbox backend (dev up will refuse; use --sandbox sprites)",
    });
  }

  const fixed: string[] = [];
  if (opts.fix) {
    for (const check of checks.filter((c) => !c.ok && c.autoFixable)) {
      if (check.id.startsWith("stale-lease:") || check.id === "supervisor") continue;
      if (check.id.startsWith("child:") && mine) {
        const sock = resolveSocketPath(mine.lockDir);
        const name = check.id.split(":")[1];
        const res = await supervisorRequest(sock, "POST", "/restart", { children: [name] }, 180_000).catch(() => null);
        if (res?.body?.ok) fixed.push(check.id);
      }
    }
  }

  const failing = checks.filter((c) => !c.ok);
  const critical = failing.filter((c) => c.severity === "critical");
  let verdict = "healthy";
  if (critical.length) verdict = "broken";
  else if (failing.length) verdict = "degraded";
  const ranked = [
    ...failing.filter((c) => c.severity === "critical"),
    ...failing.filter((c) => c.severity !== "critical"),
  ];

  if (opts.json) {
    console.log(JSON.stringify({ verdict, checks, ranked: ranked.map((c) => c.id), fixed }, null, 2));
  } else {
    console.log(`verdict: ${verdict}`);
    for (const c of checks) {
      let mark = "!";
      if (c.ok) mark = "✓";
      else if (c.severity === "critical") mark = "✗";
      console.log(`  ${mark} ${c.id}: ${c.detail}`);
      if (!c.ok && c.remedy) console.log(`      remedy: ${c.remedy}`);
    }
    if (fixed.length) console.log(`fixed: ${fixed.join(", ")}`);
  }
  return critical.length ? EXIT.doctorCritical : EXIT.ok;
}
