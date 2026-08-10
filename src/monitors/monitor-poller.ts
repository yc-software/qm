import type { Monitor, TurnRequest, TurnResult } from "../types.ts";
import type { MonitorStore } from "./monitor-store.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { IdempotencyStore } from "../idempotency/idempotency-store.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { supportsProcessSessions, type ProcessSandbox, type Sandbox, type SandboxHandle } from "../sandbox/sandbox.ts";
import { processIsGone } from "../sandbox/process-poll.ts";
import { runTrigger, type TriggerDeps, type TriggerOutcome } from "../triggers/run-trigger.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper } from "../util/sweeper.ts";
import { errMessage } from "../util/errors.ts";
import type { CurrentScopeMembers } from "../resolution/scope-membership.ts";
import { compileMonitorPattern } from "./monitor-broker.ts";

const TICK_LEASE_KEY = "monitor:poller:tick";
const MAX_EVENT_CHARS = 16_000;
const MAX_TAIL_CHARS = 4_096;
const MAX_READ_BYTES = 64 * 1024;
const DEFAULT_HEARTBEAT_MS = 180_000;
const DEFAULT_MIN_FIRE_INTERVAL_MS = 60_000;

export interface MonitorPoller {
  tick(now?: number): Promise<void>;
  start(intervalMs: number): void;
  stop(): void;
}

export interface MonitorPollerDeps {
  monitors: MonitorStore;
  processes: ProcessRegistry;
  sandbox: Sandbox;
  deliveries: DeliveryStore;
  idempotency: IdempotencyStore;
  identity: IdentityService;
  run: (req: TurnRequest) => Promise<TurnResult>;
  directory?: TriggerDeps["directory"];
  currentScopeMembers?: CurrentScopeMembers;
  sessions?: TriggerDeps["sessions"];
  now?: () => number;
  maxFiresPerTick?: number;
  leaderLease?: LeaderLease;
  heartbeatMs?: number;
  minFireIntervalMs?: number;
}

type MonitorEvent =
  | { kind: "output" }
  | { kind: "exited"; code: number }
  | { kind: "expired" }
  | { kind: "lost" }
  | { kind: "quiet"; quietMins: number };

function filterLines(chunk: string, pattern: string): string {
  let matches: (line: string) => boolean;
  try {
    matches = compileMonitorPattern(pattern);
  } catch {
    return chunk;
  }
  return chunk
    .split("\n")
    .filter((l) => l !== "" && matches(l))
    .join("\n");
}

function describeEvent(ev: MonitorEvent): string {
  if (ev.kind === "exited") return `It just exited with code ${ev.code}.`;
  if (ev.kind === "expired") {
    return "Your watch on it expired (the job may still be running — `background poll` it, or arm a new watch if you still need one).";
  }
  if (ev.kind === "lost") return "It is no longer on your computer (likely lost to a restart) — treat it as gone.";
  if (ev.kind === "quiet") {
    return `It's still running — just nothing wake-worthy in the last ~${ev.quietMins} min. Its most recent raw output (if any) is below so you can read where it's up to.`;
  }
  return "It produced new output.";
}

function replyGuidance(ev: MonitorEvent): string {
  if (ev.kind === "quiet") {
    return "This heartbeat exists so they can tell a quiet job from a stalled one: a one-line still-running note is the point, unless they asked you to stay quiet. ";
  }
  if (ev.kind === "output") return "If the new output is just noise they wouldn't care about, finish silently. ";
  return "This is the last update this watch will send, so stay quiet only if they explicitly asked for silence on this outcome. ";
}

function renderEvent(m: Monitor, output: string, ev: MonitorEvent): { input: string; securityScreenData: string } {
  const what = describeEvent(ev);
  const capped = output.length > MAX_EVENT_CHARS ? `…[truncated]\n${output.slice(-MAX_EVENT_CHARS)}` : output;
  return {
    input: [
      `[background job update — automated, not a user message] You are watching background job ${m.processId} (\`${m.command}\`) in this conversation. ${what}`,
      ...(capped.trim() ? ["", "<output>", capped, "</output>"] : []),
      ...(m.instructions ? ["", `When you armed this watch you said: ${m.instructions}`] : []),
      "",
      "Act on this. The user can't see the job, so when something changed that's worth telling them, reply with a brief update — it posts to this conversation — saying where things stand and what to expect next. " +
        replyGuidance(ev) +
        "Use the `background` tool (poll/stop/watch) if you need more than what's shown.",
    ].join("\n"),
    securityScreenData: capped,
  };
}

export function createMonitorPoller(deps: MonitorPollerDeps): MonitorPoller {
  const now = deps.now ?? (() => Date.now());
  const maxFiresPerTick = deps.maxFiresPerTick ?? 20;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const minFireIntervalMs = deps.minFireIntervalMs ?? DEFAULT_MIN_FIRE_INTERVAL_MS;
  const leaderLease = deps.leaderLease ?? createNoopLeaderLease();

  const triggerDeps: TriggerDeps = {
    deliveries: deps.deliveries,
    idempotency: deps.idempotency,
    identity: deps.identity,
    run: deps.run,
    ...(deps.directory ? { directory: deps.directory } : {}),
    ...(deps.currentScopeMembers ? { currentScopeMembers: deps.currentScopeMembers } : {}),
    ...(deps.sessions ? { sessions: deps.sessions } : {}),
  };

  async function fire(
    m: Monitor,
    fireKey: string,
    event: { input: string; securityScreenData: string },
    withErrorNotice = false,
  ): Promise<TriggerOutcome> {
    return runTrigger(triggerDeps, {
      owner: m.owner,
      ownerScopeId: m.ownerScopeId,
      input: event.input,
      securityScreenData: event.securityScreenData,
      fireKey,
      surface: "monitor",
      threadRef: m.threadRef,
      ...(m.destination ? { destination: m.destination } : {}),
      ...(withErrorNotice
        ? { errorNotice: (s) => `⚠️ A background-job update (\`${m.command}\`) could not run: ${s}` }
        : {}),
    });
  }

  async function reportLost(m: Monitor): Promise<void> {
    const outcome = await fire(m, `monitor:${m.id}:lost`, renderEvent(m, m.tail ?? "", { kind: "lost" }));
    if (!outcome.authzFailed && outcome.note) await deps.monitors.recordError(m.id, outcome.note);
    await deps.monitors.setEnabled(m.id, false);
  }

  async function stillLive(m: Monitor): Promise<boolean> {
    const fresh = await deps.monitors.get(m.id);
    return fresh !== null && fresh.enabled;
  }

  async function poll(sandbox: ProcessSandbox, handle: SandboxHandle, m: Monitor, t: number): Promise<boolean> {
    if (!(await stillLive(m))) return false;
    let read;
    try {
      read = await sandbox.readProcess(handle, m.processId, {
        sinceCursor: m.cursor,
        maxBytes: MAX_READ_BYTES,
        waitMs: 0,
      });
    } catch (e) {
      if (processIsGone(e)) {
        await reportLost(m);
        return true;
      }
      await deps.monitors.recordError(m.id, errMessage(e));
      return false;
    }

    const exited = read.status.state === "exited";
    const expired = !exited && t >= m.expiresAt;
    const raw = (m.tail ?? "") + read.chunks;
    let events = raw;
    let tail: string | undefined;
    if (m.pattern) {
      if (exited || expired) {
        events = filterLines(raw, m.pattern);
      } else {
        const lastNl = raw.lastIndexOf("\n");
        tail = (lastNl === -1 ? raw : raw.slice(lastNl + 1)).slice(-MAX_TAIL_CHARS) || undefined;
        events = lastNl === -1 ? "" : filterLines(raw.slice(0, lastNl + 1), m.pattern);
      }
    }

    if (!events.trim() && !exited && !expired) {
      const quietSince = m.lastFiredAt ?? m.createdAt;
      if (heartbeatMs > 0 && t - quietSince >= heartbeatMs) {
        const quietMins = Math.max(1, Math.round((t - quietSince) / 60_000));
        const outcome = await fire(
          m,
          `monitor:${m.id}:quiet:${quietSince}`,
          renderEvent(m, raw.slice(-MAX_TAIL_CHARS), { kind: "quiet", quietMins }),
        );
        if (outcome.authzFailed) {
          await deps.monitors.setEnabled(m.id, false);
          return true;
        }
        if (outcome.note) await deps.monitors.recordError(m.id, outcome.note);
        await deps.monitors.advance(m.id, { cursor: read.cursor, tail, firedAt: t });
        return true;
      }
      if (read.cursor !== m.cursor || tail !== m.tail) await deps.monitors.advance(m.id, { cursor: read.cursor, tail });
      return false;
    }

    if (!exited && !expired && minFireIntervalMs > 0) {
      const sinceFire = t - (m.lastFiredAt ?? 0);
      if (m.lastFiredAt !== undefined && sinceFire < minFireIntervalMs) return false;
    }

    let ev: MonitorEvent = { kind: "output" };
    let fireKey = `monitor:${m.id}:${m.cursor}`;
    if (exited) {
      ev = { kind: "exited", code: read.status.state === "exited" ? read.status.code : 0 };
      fireKey = `monitor:${m.id}:exit`;
    } else if (expired) {
      ev = { kind: "expired" };
      fireKey = `monitor:${m.id}:expired`;
    }
    const outcome = await fire(m, fireKey, renderEvent(m, events, ev), true);
    if (outcome.authzFailed) {
      await deps.monitors.setEnabled(m.id, false);
      return true;
    }
    if (outcome.note) await deps.monitors.recordError(m.id, outcome.note);
    if (await deps.monitors.get(m.id)) {
      await deps.monitors.advance(m.id, { cursor: read.cursor, tail, firedAt: t });
      if (exited || expired) await deps.monitors.setEnabled(m.id, false);
    }
    if (exited) await deps.processes.markStatus(m.processId, "exited");
    return true;
  }

  async function pollAll(t: number): Promise<void> {
    if (!supportsProcessSessions(deps.sandbox)) return;
    const sandbox = deps.sandbox;
    const enabled = (await deps.monitors.enabled()).sort((a, b) => a.createdAt - b.createdAt);
    if (enabled.length === 0) return;

    const handles = new Map<string, SandboxHandle>();
    let fires = 0;
    try {
      for (const m of enabled) {
        if (fires >= maxFiresPerTick) {
          console.warn(`[monitor] fan-out capped: fired ${fires}/${enabled.length} watched jobs this tick`);
          break;
        }
        const rec = await deps.processes.get(m.processId);
        if (!rec) {
          await reportLost(m);
          fires++;
          continue;
        }
        let handle = handles.get(rec.scopeId);
        if (!handle) {
          try {
            handle = await sandbox.provision([{ scopeId: rec.scopeId, mode: "rw", mountPath: "" }]);
          } catch (e) {
            await deps.monitors.recordError(m.id, errMessage(e));
            continue;
          }
          handles.set(rec.scopeId, handle);
        }
        try {
          if (await poll(sandbox, handle, m, t)) fires++;
        } catch (e) {
          await deps.monitors.recordError(m.id, errMessage(e));
          console.error(`[monitor] poll failed for ${m.id}:`, e);
        }
      }
    } finally {
      for (const handle of handles.values()) {
        await sandbox.teardown(handle, { keepWarm: true }).catch((e: unknown) => {
          console.error("[monitor] teardown failed:", e);
        });
      }
    }
  }

  const tick = async (nowArg?: number): Promise<void> => {
    const t = nowArg ?? now();
    await leaderLease.hold(TICK_LEASE_KEY, () => pollAll(t));
  };

  const sweeper = createSweeper(
    () => tick().catch((e: unknown) => console.error("[monitor] tick failed:", e)),
    10_000,
    { label: "monitor" },
  );
  return {
    tick,
    start: sweeper.start,
    stop: sweeper.stop,
  };
}
