import type { ProcessSandbox, ProcessState, SandboxHandle } from "../sandbox/sandbox.ts";
import type { ProcessRegistry, ProcessStatus } from "../processes/process-registry.ts";
import type { ProcessCredentialFiles } from "../credentials/execute-files.ts";
import { awaitProcessExit } from "../sandbox/await-process-exit.ts";
import { pollProcess, processIsGone } from "../sandbox/process-poll.ts";
import { redactCommand } from "../sandbox/exec-process-session.ts";
import { CONFIG_DEFAULTS } from "../config.ts";
import { createExactSecretValueMasker } from "../security/secret-masking.ts";
import { withCleanup } from "../util/errors.ts";

export interface BackgroundExecBrokerDeps {
  sandbox: ProcessSandbox;
  registry: ProcessRegistry;
  provisionSandbox?: (id: string) => Promise<SandboxHandle>;
  onExit?: (handle: SandboxHandle, processId: string) => Promise<void>;
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

export interface BackgroundCredentials {
  env: Record<string, string>;
  secrets: readonly string[];
  files?: ProcessCredentialFiles;
  release?: () => Promise<void>;
}

export interface BackgroundExecBroker {
  handleFor?(processId: string): Promise<SandboxHandle | null>;
  start(
    handle: SandboxHandle,
    command: string,
    purpose: string,
    ttlMs?: number,
    credentials?: BackgroundCredentials,
  ): Promise<BackgroundStartResult>;
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

  const exited = async (handle: SandboxHandle, processId: string) => {
    await deps.registry.markStatus(processId, "exited");
    await deps.onExit?.(handle, processId);
  };
  return {
    async handleFor(processId) {
      const rec = await deps.registry.get(processId);
      if (!rec || rec.scopeId !== deps.scopeId || rec.kind !== "background") throw new Error("no such background job");
      if (!rec.sandboxId) return null;
      if (!deps.provisionSandbox) throw new Error("background job sandbox is unavailable");
      return deps.provisionSandbox(rec.sandboxId);
    },
    async start(handle, command, purpose, ttlMs, credentials): Promise<BackgroundStartResult> {
      if (!purpose?.trim()) throw new Error("background start requires a short purpose describing the job");
      purpose = redactCommand(purpose.replace(/\s+/g, " ").trim(), handle.env);
      const ttl = Math.min(ttlMs ?? defaultTtlMs, maxTtlMs);

      const normalized = `bg: ${command.replace(/\s+/g, " ").trim()}`;
      const redacted = redactCommand(normalized, handle.env);

      let processId =
        redacted === normalized && !credentials
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
            await exited(handle, existingProcessId);
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
        if (read.status.state === "exited") await exited(handle, processId);
        return {
          processId,
          output: read.chunks,
          cursor: read.cursor,
          status: read.status,
          reattached: true,
        };
      }

      let launched = false;
      try {
        const mask = createExactSecretValueMasker(credentials?.secrets ?? []);
        const register = async (id: string): Promise<void> => {
          launched = true;
          await deps.registry.register({
            processId: id,
            scopeId: deps.scopeId,
            ...(handle.resourceId ? { sandboxId: handle.resourceId } : {}),
            kind: "background",
            command: redacted,
            purpose,
            ttlMs: ttl,
            ...(deps.sessionRef ? { sessionRef: deps.sessionRef } : {}),
            ...(credentials?.files ? { credentialFiles: credentials.files } : {}),
          });
        };
        const startOptions = { env: { PYTHONUNBUFFERED: "1", ...credentials?.env } };
        if (deps.sandbox.startRegisteredProcess) {
          ({ processId } = await deps.sandbox.startRegisteredProcess(handle, command, register, startOptions));
        } else {
          ({ processId } = await deps.sandbox.startProcess(handle, command, startOptions));
          launched = true;
          await register(processId);
        }

        const { output, cursor, status } = await pollProcess(deps.sandbox, handle, processId, {
          deadlineMs: POLL_MS,
        });
        if (status.state === "exited") await exited(handle, processId);
        return { processId, output: mask(output), cursor, status, reattached: false };
      } catch (error) {
        return withCleanup(
          () => Promise.reject(error),
          async () => {
            if (!launched) await credentials?.release?.();
          },
        );
      }
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
      if (read.status.state === "exited") await exited(handle, processId);
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
      if (read.status.state === "exited") await exited(handle, processId);
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
      if (status.state === "exited") await exited(handle, processId);
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
}
