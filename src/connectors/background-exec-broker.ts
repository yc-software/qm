import type { ProcessSandbox, ProcessState, SandboxHandle } from "../sandbox/sandbox.ts";
import type { ProcessRegistry, ProcessStatus } from "../processes/process-registry.ts";
import { awaitProcessExit } from "../sandbox/await-process-exit.ts";
import { pollProcess, processIsGone } from "../sandbox/process-poll.ts";
import { redactCommand } from "../sandbox/exec-process-session.ts";
import { CONFIG_DEFAULTS } from "../config.ts";

export interface BackgroundExecBrokerDeps {
  sandbox: ProcessSandbox;
  registry: ProcessRegistry;
  scopeId: string;
  sessionRef?: string;
  ttlMs?: number;
  ttlMaxMs?: number;
  pollMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
}

export interface BackgroundStartResult {
  processId: string;
  output: string;
  cursor: number;
  status: ProcessState;
  reattached: boolean;
}

export interface BackgroundPollResult {
  processId: string;
  chunks: string;
  cursor: number;
  status: ProcessState;
}

export interface BackgroundStopResult {
  processId: string;
  status: ProcessState;
  stopped: boolean;
}

export interface BackgroundJobSummary {
  processId: string;
  command: string;
  status: ProcessState;
  registryStatus: ProcessStatus;
  startedAt: number;
}

export interface BackgroundWriteResult {
  processId: string;
  bytes: number;
  status: ProcessState;
}

export interface BackgroundExecBroker {
  start(handle: SandboxHandle, command: string, ttlMs?: number): Promise<BackgroundStartResult>;
  poll(
    handle: SandboxHandle,
    processId: string,
    opts?: { sinceCursor?: number; maxBytes?: number; waitMs?: number },
  ): Promise<BackgroundPollResult>;
  write(handle: SandboxHandle, processId: string, data: string): Promise<BackgroundWriteResult>;
  stop(handle: SandboxHandle, processId: string, signal?: string): Promise<BackgroundStopResult>;
  list(): Promise<BackgroundJobSummary[]>;
}

const DEFAULT_TTL_MS = CONFIG_DEFAULTS.backgroundJobTtlSec * 1000;
const DEFAULT_TTL_MAX_MS = CONFIG_DEFAULTS.backgroundJobTtlMaxSec * 1000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;

function stateFromRow(status: ProcessStatus): ProcessState {
  if (status === "running") return { state: "running" };
  return { state: "exited", code: status === "reaped" ? 143 : 0 };
}

export function createBackgroundBroker(deps: BackgroundExecBrokerDeps): BackgroundExecBroker {
  const POLL_MS = deps.pollMs ?? 5_000;
  const defaultTtlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const maxTtlMs = deps.ttlMaxMs ?? DEFAULT_TTL_MAX_MS;
  const termGraceMs = deps.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return {
    async start(handle, command, ttlMs): Promise<BackgroundStartResult> {
      const ttl = Math.min(ttlMs ?? defaultTtlMs, maxTtlMs);

      const normalized = `bg: ${command.replace(/\s+/g, " ").trim()}`;
      const redacted = redactCommand(normalized, handle.env);

      let processId =
        redacted === normalized
          ? ((await deps.registry.listByScope(deps.scopeId)).find(
              (r) => r.kind === "background" && r.command === redacted && r.status === "running",
            )?.processId ?? null)
          : null;

      if (processId) {
        const existingProcessId = processId;
        try {
          const read = await deps.sandbox.readProcess(handle, existingProcessId, {
            sinceCursor: 0,
            maxBytes: 1,
            waitMs: 0,
          });
          if (read.status.state === "exited") {
            await deps.registry.markStatus(existingProcessId, "exited");
            processId = null;
          }
        } catch (error) {
          if (!processIsGone(error)) throw error;
          await deps.registry.delete(existingProcessId);
          processId = null;
        }
      }

      if (processId) {
        const read = await deps.sandbox.readProcess(handle, processId, {
          sinceCursor: 0,
          maxBytes: DEFAULT_MAX_BYTES,
          waitMs: 0,
        });
        if (read.status.state === "exited") await deps.registry.markStatus(processId, "exited");
        return { processId, output: read.chunks, cursor: read.cursor, status: read.status, reattached: true };
      }

      ({ processId } = await deps.sandbox.startProcess(handle, command, {
        env: { PYTHONUNBUFFERED: "1" },
      }));
      await deps.registry.register({
        processId,
        scopeId: deps.scopeId,
        kind: "background",
        command: redacted,
        ttlMs: ttl,
        ...(deps.sessionRef ? { sessionRef: deps.sessionRef } : {}),
      });

      const { output, cursor, status } = await pollProcess(deps.sandbox, handle, processId, { deadlineMs: POLL_MS });
      if (status.state === "exited") await deps.registry.markStatus(processId, "exited");
      return { processId, output, cursor, status, reattached: false };
    },

    async poll(handle, processId, opts): Promise<BackgroundPollResult> {
      const rec = await deps.registry.get(processId);
      if (!rec || rec.scopeId !== deps.scopeId || rec.kind !== "background") {
        throw new Error("no such background job");
      }
      const read = await deps.sandbox.readProcess(handle, processId, {
        sinceCursor: opts?.sinceCursor ?? 0,
        maxBytes: opts?.maxBytes ?? DEFAULT_MAX_BYTES,
        waitMs: opts?.waitMs ?? 0,
      });
      if (read.status.state === "exited") await deps.registry.markStatus(processId, "exited");
      return { processId, chunks: read.chunks, cursor: read.cursor, status: read.status };
    },

    async write(handle, processId, data): Promise<BackgroundWriteResult> {
      const rec = await deps.registry.get(processId);
      if (!rec || rec.scopeId !== deps.scopeId || rec.kind !== "background") {
        throw new Error("no such background job");
      }
      await deps.sandbox.writeStdin(handle, processId, data);
      const read = await deps.sandbox.readProcess(handle, processId, { sinceCursor: 0, maxBytes: 1, waitMs: 0 });
      if (read.status.state === "exited") await deps.registry.markStatus(processId, "exited");
      return { processId, bytes: data.length, status: read.status };
    },

    async stop(handle, processId, signal = "TERM"): Promise<BackgroundStopResult> {
      const rec = await deps.registry.get(processId);
      if (!rec || rec.scopeId !== deps.scopeId || rec.kind !== "background") {
        throw new Error("no such background job");
      }
      await deps.sandbox.signalProcess(handle, processId, signal);
      let status = await awaitProcessExit(deps.sandbox, handle, processId, termGraceMs);
      if (status.state !== "exited" && signal !== "KILL") {
        await deps.sandbox.signalProcess(handle, processId, "KILL");
        status = await awaitProcessExit(deps.sandbox, handle, processId, killGraceMs);
      }
      if (status.state === "exited") await deps.registry.markStatus(processId, "exited");
      return { processId, status, stopped: status.state === "exited" };
    },

    async list(): Promise<BackgroundJobSummary[]> {
      return (await deps.registry.listByScope(deps.scopeId))
        .filter((r) => r.kind === "background")
        .map((r) => ({
          processId: r.processId,
          command: r.command,
          status: stateFromRow(r.status),
          registryStatus: r.status,
          startedAt: r.startedAt,
        }));
    },
  };
}
