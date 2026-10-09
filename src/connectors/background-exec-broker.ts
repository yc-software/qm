import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { ProcessSandbox, ProcessState, SandboxHandle } from "../sandbox/sandbox.ts";
import type { ProcessRegistry, ProcessStatus, CredentialCaptureSnapshot } from "../processes/process-registry.ts";
import { awaitProcessExit } from "../sandbox/await-process-exit.ts";
import { pollProcess, processIsGone } from "../sandbox/process-poll.ts";
import { redactCommand } from "../sandbox/exec-process-session.ts";
import { CONFIG_DEFAULTS } from "../config.ts";

export interface BackgroundExecBrokerDeps {
  sandbox: ProcessSandbox;
  registry: ProcessRegistry;
  provisionSandbox?: (id: string) => Promise<SandboxHandle>;
  credentialExecutionLock?: AdvisoryLock;
  prepareStart?: (handle: SandboxHandle) => Promise<void>;
  captureSnapshot?: (handle: SandboxHandle) => Promise<CredentialCaptureSnapshot | undefined>;
  completed?: (handle: SandboxHandle, snapshot: CredentialCaptureSnapshot) => Promise<boolean | void>;
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
  purpose?: string;
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
  handleFor?(processId: string): Promise<SandboxHandle | null>;
  start(handle: SandboxHandle, command: string, purpose: string, ttlMs?: number): Promise<BackgroundStartResult>;
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

  const complete = async (handle: SandboxHandle, processId: string) => {
    const record = await deps.registry.get(processId);
    if (record?.credentialCapture) {
      if ((await deps.completed?.(handle, record.credentialCapture)) !== false)
        await deps.registry.finishCredentialCapture(processId);
    }
    await deps.registry.markStatus(processId, "exited");
  };
  const broker: BackgroundExecBroker = {
    async handleFor(processId) {
      const rec = await deps.registry.get(processId);
      if (!rec || rec.scopeId !== deps.scopeId || rec.kind !== "background") throw new Error("no such background job");
      if (!rec.sandboxId) return null;
      if (!deps.provisionSandbox) throw new Error("background job sandbox is unavailable");
      return deps.provisionSandbox(rec.sandboxId);
    },
    async start(handle, command, purpose, ttlMs): Promise<BackgroundStartResult> {
      if (!purpose?.trim()) throw new Error("background start requires a short purpose describing the job");
      purpose = redactCommand(purpose.replace(/\s+/g, " ").trim(), handle.env);
      const ttl = Math.min(ttlMs ?? defaultTtlMs, maxTtlMs);

      const normalized = `bg: ${command.replace(/\s+/g, " ").trim()}`;
      const redacted = redactCommand(normalized, handle.env);

      let processId =
        redacted === normalized
          ? ((await deps.registry.listByScope(deps.scopeId)).find(
              (r) =>
                r.kind === "background" &&
                r.command === redacted &&
                r.status === "running" &&
                r.sandboxId === handle.resourceId,
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
            await complete(handle, existingProcessId);
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
        if (read.status.state === "exited") {
          await complete(handle, processId);
        }
        return { processId, output: read.chunks, cursor: read.cursor, status: read.status, reattached: true };
      }

      await deps.prepareStart?.(handle);
      const credentialCapture = await deps.captureSnapshot?.(handle);
      const register = async (id: string): Promise<void> => {
        await deps.registry.register({
          processId: id,
          scopeId: deps.scopeId,
          ...(handle.resourceId ? { sandboxId: handle.resourceId } : {}),
          kind: "background",
          ...(credentialCapture ? { credentialCapture } : {}),
          command: redacted,
          purpose,
          ttlMs: ttl,
          ...(deps.sessionRef ? { sessionRef: deps.sessionRef } : {}),
        });
      };
      const startOptions = { env: { PYTHONUNBUFFERED: "1" } };
      if (deps.sandbox.startRegisteredProcess) {
        ({ processId } = await deps.sandbox.startRegisteredProcess(handle, command, register, startOptions));
      } else {
        ({ processId } = await deps.sandbox.startProcess(handle, command, startOptions));
        await register(processId);
      }

      const { output, cursor, status } = await pollProcess(deps.sandbox, handle, processId, { deadlineMs: POLL_MS });
      if (status.state === "exited") {
        await complete(handle, processId);
      }
      return { processId, output, cursor, status, reattached: false };
    },

    async poll(handle, processId, opts): Promise<BackgroundPollResult> {
      const rec = await deps.registry.get(processId);
      if (!rec || rec.scopeId !== deps.scopeId || rec.kind !== "background") {
        throw new Error("no such background job");
      }
      if (rec.sandboxId && rec.sandboxId !== handle.resourceId) {
        if (!deps.provisionSandbox) throw new Error("background job sandbox is unavailable");
        handle = await deps.provisionSandbox(rec.sandboxId);
      }
      const read = await deps.sandbox.readProcess(handle, processId, {
        sinceCursor: opts?.sinceCursor ?? 0,
        maxBytes: opts?.maxBytes ?? DEFAULT_MAX_BYTES,
        waitMs: opts?.waitMs ?? 0,
      });
      if (read.status.state === "exited") {
        await complete(handle, processId);
      }
      return { processId, chunks: read.chunks, cursor: read.cursor, status: read.status };
    },

    async write(handle, processId, data): Promise<BackgroundWriteResult> {
      const rec = await deps.registry.get(processId);
      if (!rec || rec.scopeId !== deps.scopeId || rec.kind !== "background") {
        throw new Error("no such background job");
      }
      if (rec.sandboxId && rec.sandboxId !== handle.resourceId) {
        if (!deps.provisionSandbox) throw new Error("background job sandbox is unavailable");
        handle = await deps.provisionSandbox(rec.sandboxId);
      }
      await deps.sandbox.writeStdin(handle, processId, data);
      const read = await deps.sandbox.readProcess(handle, processId, { sinceCursor: 0, maxBytes: 1, waitMs: 0 });
      if (read.status.state === "exited") {
        await complete(handle, processId);
      }
      return { processId, bytes: data.length, status: read.status };
    },

    async stop(handle, processId, signal = "TERM"): Promise<BackgroundStopResult> {
      const rec = await deps.registry.get(processId);
      if (!rec || rec.scopeId !== deps.scopeId || rec.kind !== "background") {
        throw new Error("no such background job");
      }
      if (rec.sandboxId && rec.sandboxId !== handle.resourceId) {
        if (!deps.provisionSandbox) throw new Error("background job sandbox is unavailable");
        handle = await deps.provisionSandbox(rec.sandboxId);
      }
      await deps.sandbox.signalProcess(handle, processId, signal);
      let status = await awaitProcessExit(deps.sandbox, handle, processId, termGraceMs);
      if (status.state !== "exited" && signal !== "KILL") {
        await deps.sandbox.signalProcess(handle, processId, "KILL");
        status = await awaitProcessExit(deps.sandbox, handle, processId, killGraceMs);
      }
      if (status.state === "exited") {
        await complete(handle, processId);
      }
      return { processId, status, stopped: status.state === "exited" };
    },

    async list(): Promise<BackgroundJobSummary[]> {
      return (await deps.registry.listByScope(deps.scopeId))
        .filter((r) => r.kind === "background")
        .map((r) => ({
          processId: r.processId,
          command: r.command,
          ...(r.purpose ? { purpose: r.purpose } : {}),
          status: stateFromRow(r.status),
          registryStatus: r.status,
          startedAt: r.startedAt,
        }));
    },
  };
  const exclusive = <T>(
    handle: SandboxHandle,
    operation: (selected: SandboxHandle) => Promise<T>,
    processId?: string,
  ): Promise<T> => {
    const run = async () => {
      const selected = processId ? ((await broker.handleFor?.(processId)) ?? handle) : handle;
      return deps.credentialExecutionLock
        ? deps.credentialExecutionLock.withLock(
            `credential-execution:${selected.backend}:${selected.resourceId ?? selected.id}`,
            () => operation(selected),
          )
        : operation(selected);
    };
    return run();
  };
  return {
    ...broker,
    start: (handle, command, purpose, ttl) =>
      exclusive(handle, (selected) => broker.start(selected, command, purpose, ttl)),
    poll: (handle, id, opts) => exclusive(handle, (selected) => broker.poll(selected, id, opts), id),
    write: (handle, id, data) => exclusive(handle, (selected) => broker.write(selected, id, data), id),
    stop: (handle, id, signal) => exclusive(handle, (selected) => broker.stop(selected, id, signal), id),
  };
}
