import {
  ClientError,
  Render,
  SandboxEndedError,
  SandboxSnapshotFailedError,
  SandboxSnapshotNotFoundError,
  SandboxSnapshotWaitTimeoutError,
  ServerError,
} from "@renderinc/sdk";
import { randomUUID } from "node:crypto";
import { retryOperation, withAbort } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { RENDER_SNAPSHOT_RETENTION_MS } from "./render-limits.ts";

export const RENDER_SCRIPT_DIR = "/dev/.qm-run";
const RENDER_SANDBOX_PLAN = "2c-4g";
const CONTROL_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 300_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const CHECKPOINT_SETTLE_MS = 180_000;
const SANDBOX_START_MS = 180_000;
const STALE_SCRIPT_MINUTES = 5;
const LIST_PAGE_SIZE = 100;
const LIVE_STATUSES = ["creating", "running", "suspending", "suspended", "resuming"] as const;
const KILL_AFTER_SEC = 5;

const sdkErrors = {
  statusOf: (error: unknown): number | undefined =>
    error instanceof ClientError || error instanceof ServerError ? error.statusCode : undefined,
  networkError: (error: unknown): boolean => error instanceof TypeError,
};

export interface RenderSandboxInfo {
  id: string;
  status: string;
  expiresAtMs: number;
}

export interface RenderListedSandbox {
  id: string;
  createdAtMs: number;
}

interface RenderCreateOptions {
  name?: string;
  snapshotId?: string;
  image?: string;
  lifetimeSec: number;
  onCreated?: (sandboxId: string) => Promise<void>;
}

export interface RenderSnapshot {
  id: string;
  sandboxGroupId: string;
  status: "creating" | "available" | "failed";
  expiresAtMs: number;
  capturedAtMs?: number;
  error?: string;
}

export interface RenderImage {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  sourceDigest: string;
  failureReason?: string;
}

export interface RenderClient {
  create(options: RenderCreateOptions): Promise<RenderSandboxInfo>;
  importImage(source: string, name: string): Promise<RenderImage>;
  get(sandboxId: string): Promise<RenderSandboxInfo | null>;
  listLive(name: string): Promise<RenderListedSandbox[]>;
  terminate(sandboxId: string): Promise<void>;
  runScript(
    sandboxId: string,
    script: string,
    timeoutSec: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFileBytes(sandboxId: string, absPath: string): Promise<Uint8Array | null>;
  writeFileBytes(sandboxId: string, absPath: string, data: Uint8Array): Promise<void>;
  createSnapshot(sandboxId: string, name: string): Promise<RenderSnapshot>;
  getSnapshot(snapshot: RenderSnapshot): Promise<RenderSnapshot>;
  waitSnapshot(snapshot: RenderSnapshot): Promise<RenderSnapshot>;
  deleteSnapshot(snapshot: RenderSnapshot): Promise<void>;
}

export interface SdkRenderClientOptions {
  apiKey: string;
  workspaceId: string;
}

export function createSdkRenderClient(opts: SdkRenderClientOptions): RenderClient {
  const api = new Render({ token: opts.apiKey, ownerId: opts.workspaceId }).sandboxes;
  const normalizeInfo = (value: Awaited<ReturnType<typeof api.create>>): RenderSandboxInfo => ({
    id: value.id,
    status: value.status,
    expiresAtMs: Date.parse(value.createdAt) + value.timeoutSeconds * 1000,
  });
  const normalizeSnapshot = (value: Awaited<ReturnType<typeof api.snapshots.create>>): RenderSnapshot => ({
    id: value.id,
    sandboxGroupId: value.sandboxGroupId,
    status: value.status,
    expiresAtMs: Date.parse(value.expiresAt),
    ...(value.capturedAt ? { capturedAtMs: Date.parse(value.capturedAt) } : {}),
    ...(value.error ? { error: value.error } : {}),
  });
  const isMissing = (error: unknown): boolean => error instanceof ClientError && error.statusCode === 404;
  const get = async (sandboxId: string): Promise<RenderSandboxInfo | null> => {
    try {
      return normalizeInfo(
        await retryOperation(() => api.get(sandboxId), "idempotent", { ...sdkErrors, timeoutMs: CONTROL_TIMEOUT_MS }),
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };
  const terminate = async (sandboxId: string): Promise<void> => {
    try {
      await retryOperation(() => api.terminate(sandboxId), "idempotent", {
        ...sdkErrors,
        timeoutMs: CONTROL_TIMEOUT_MS,
      });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };
  const exec = (sandboxId: string, command: string, signal: AbortSignal) =>
    withAbort(async () => {
      const stream = await api.exec(sandboxId, command, undefined, signal);
      let stdout = "";
      let stderr = "";
      for await (const event of stream) {
        if (event.type === "exit") return { stdout, stderr, exitCode: event.exit_code };
        if (event.stream === "stdout") stdout += event.data;
        else stderr += event.data;
      }
      throw new Error(`Render sandbox ${sandboxId}: command stream ended without an exit code`);
    }, signal);
  const getSnapshot = async (snapshot: RenderSnapshot): Promise<RenderSnapshot> =>
    normalizeSnapshot(
      await retryOperation(
        () => api.snapshots.get({ sandboxGroupId: snapshot.sandboxGroupId, snapshotId: snapshot.id }),
        "idempotent",
        { ...sdkErrors, timeoutMs: CONTROL_TIMEOUT_MS },
      ),
    );
  const settleSnapshot = (snapshot: RenderSnapshot) =>
    retryOperation(
      (signal) =>
        api.snapshots.waitUntilAvailable(
          { sandboxGroupId: snapshot.sandboxGroupId, snapshotId: snapshot.id },
          { timeoutMs: CHECKPOINT_SETTLE_MS, signal },
        ),
      "idempotent",
      { ...sdkErrors, timeoutMs: CHECKPOINT_SETTLE_MS + CONTROL_TIMEOUT_MS },
    );
  const waitSnapshot = async (snapshot: RenderSnapshot): Promise<RenderSnapshot> => {
    try {
      return normalizeSnapshot(await settleSnapshot(snapshot));
    } catch (error) {
      if (error instanceof SandboxSnapshotFailedError)
        throw new Error(`Render checkpoint ${snapshot.id} failed: ${error.snapshotError || "no provider reason"}`, {
          cause: error,
        });
      throw error;
    }
  };
  const discardLateCheckpoint = async (late: RenderSnapshot): Promise<void> => {
    try {
      await settleSnapshot(late);
    } catch (error) {
      if (error instanceof SandboxSnapshotNotFoundError) return;
      if (!(error instanceof SandboxSnapshotFailedError || error instanceof SandboxSnapshotWaitTimeoutError))
        throw error;
    }
    await deleteSnapshot(late);
  };
  const deleteSnapshot = async (snapshot: RenderSnapshot): Promise<void> => {
    try {
      await retryOperation(
        () => api.snapshots.delete({ sandboxGroupId: snapshot.sandboxGroupId, snapshotId: snapshot.id }),
        "idempotent",
        { ...sdkErrors, timeoutMs: CONTROL_TIMEOUT_MS },
      );
    } catch (error) {
      if (!(error instanceof SandboxSnapshotNotFoundError)) throw error;
    }
  };
  const runScript: RenderClient["runScript"] = async (sandboxId, script, timeoutSec) => {
    const path = `${RENDER_SCRIPT_DIR}/${randomUUID()}.sh`;
    const signal = AbortSignal.timeout(
      (timeoutSec + KILL_AFTER_SEC) * 1000 + Math.min(CONTROL_TIMEOUT_MS, Math.max(timeoutSec, KILL_AFTER_SEC) * 1000),
    );
    const prelude = `rm -f ${shq(path)}; find ${shq(RENDER_SCRIPT_DIR)} -type f -mmin +${STALE_SCRIPT_MINUTES} -delete 2>/dev/null\n`;
    try {
      await retryOperation(
        (attempt) => api.upload(sandboxId, path, Buffer.from(prelude + script), undefined, { signal: attempt }),
        "idempotent",
        { ...sdkErrors, signal, timeoutMs: TRANSFER_TIMEOUT_MS },
      );
      return await exec(
        sandboxId,
        `sh -c ${shq(
          `s=$(date +%s); $(command -v setsid) timeout -k ${KILL_AFTER_SEC} ${timeoutSec} sh ${shq(path)} & p=$!; wait $p; rc=$?; if [ $rc -eq 124 ] || [ $rc -eq 137 ]; then [ $(($(date +%s) - s)) -lt ${timeoutSec} ] || kill -s KILL -- -$p 2>/dev/null; fi; exit $rc`,
        )}`,
        signal,
      );
    } catch (error) {
      if (error instanceof SandboxEndedError) throw error;
      await exec(sandboxId, `rm -f ${shq(path)}`, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(
        swallowAs(`render-client: remove uploaded script ${path}`, undefined),
      );
      throw error;
    }
  };
  return {
    async create({ name, snapshotId, image, lifetimeSec, onCreated }) {
      let source: { snapshotId: string } | { image: string } | Record<string, never> = {};
      if (snapshotId) source = { snapshotId };
      else if (image) source = { image };
      const label = name ? { name } : {};
      const created = await retryOperation(
        () =>
          api.create({
            plan: RENDER_SANDBOX_PLAN,
            timeoutSeconds: lifetimeSec,
            idleTimeoutSeconds: 0,
            ...label,
            ...source,
          }),
        "refused",
        {
          ...sdkErrors,
          timeoutMs: SUBMIT_TIMEOUT_MS,
          onLate: (late) =>
            terminate(late.id).catch(swallowAs(`render-client: terminate late sandbox ${late.id}`, undefined)),
        },
      );
      try {
        await onCreated?.(created.id);
        return normalizeInfo(
          await retryOperation(
            (signal) => api.waitUntilRunning(created.id, { timeoutMs: SANDBOX_START_MS, signal }),
            "idempotent",
            { ...sdkErrors, timeoutMs: SANDBOX_START_MS + CONTROL_TIMEOUT_MS },
          ),
        );
      } catch (error) {
        await terminate(created.id).catch(
          swallowAs(`render-client: terminate unready sandbox ${created.id}`, undefined),
        );
        throw error;
      }
    },
    async importImage(source, name) {
      const groups = () =>
        retryOperation(() => api.listGroups(), "idempotent", { ...sdkErrors, timeoutMs: CONTROL_TIMEOUT_MS });
      let listed = await groups();
      if (!listed.length) {
        await retryOperation(
          () =>
            api.createGroup({ name: "qm" }).catch((error: unknown) => {
              if (!(error instanceof ClientError && error.statusCode === 409)) throw error;
            }),
          "idempotent",
          { ...sdkErrors, timeoutMs: CONTROL_TIMEOUT_MS },
        );
        listed = await groups();
      }
      const sandboxGroupId = listed.find((entry) => entry.sandboxGroup.isDefault)?.sandboxGroup.id;
      if (!sandboxGroupId)
        throw new Error("Render workspace has no default sandbox group; set one in the Render dashboard");
      const image = await retryOperation(() => api.images.import({ sandboxGroupId, name, source }), "idempotent", {
        ...sdkErrors,
        timeoutMs: SUBMIT_TIMEOUT_MS,
      });
      return {
        id: image.id,
        status: image.status,
        sourceDigest: image.sourceDigest,
        ...(image.failureReason ? { failureReason: image.failureReason } : {}),
      };
    },
    get,
    async listLive(name) {
      const listed: RenderListedSandbox[] = [];
      for (let cursor: string | undefined; ;) {
        const after = cursor ? { cursor } : {};
        const page = await retryOperation(
          () => api.list({ name, status: [...LIVE_STATUSES], limit: LIST_PAGE_SIZE, ...after }),
          "idempotent",
          { ...sdkErrors, timeoutMs: CONTROL_TIMEOUT_MS },
        );
        for (const entry of page)
          listed.push({ id: entry.sandbox.id, createdAtMs: Date.parse(entry.sandbox.createdAt) });
        if (page.length < LIST_PAGE_SIZE) return listed;
        cursor = page.at(-1)!.cursor;
      }
    },
    terminate,
    runScript,
    async readFileBytes(sandboxId, absPath) {
      const exists = await exec(sandboxId, `test -f ${shq(absPath)}`, AbortSignal.timeout(CONTROL_TIMEOUT_MS));
      if (exists.exitCode === 1) return null;
      if (exists.exitCode !== 0) throw new Error(`Render sandbox could not read ${absPath}: ${exists.stderr}`);
      return (
        await retryOperation((signal) => api.download(sandboxId, absPath, undefined, signal), "idempotent", {
          ...sdkErrors,
          timeoutMs: TRANSFER_TIMEOUT_MS,
        })
      ).data;
    },
    async writeFileBytes(sandboxId, absPath, data) {
      await retryOperation((signal) => api.upload(sandboxId, absPath, data, undefined, { signal }), "idempotent", {
        ...sdkErrors,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
    },
    async createSnapshot(sandboxId, name) {
      return normalizeSnapshot(
        await retryOperation(
          () =>
            api.snapshots.create({
              sandboxId,
              kind: "filesystem",
              name,
              expiresAt: new Date(Date.now() + RENDER_SNAPSHOT_RETENTION_MS).toISOString(),
            }),
          "refused",
          {
            ...sdkErrors,
            timeoutMs: SUBMIT_TIMEOUT_MS,
            onLate: (late) =>
              discardLateCheckpoint(normalizeSnapshot(late)).catch(
                swallowAs(`render-client: delete late checkpoint ${late.id}`, undefined),
              ),
          },
        ),
      );
    },
    getSnapshot,
    waitSnapshot,
    deleteSnapshot,
  };
}
