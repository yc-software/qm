import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { AwsApiError, createMicrovmApi, createMicrovmClient, type AwsMicrovmApi } from "./aws-microvm-api.ts";
import {
  createProviderSandbox,
  scopeOfName,
  type ProviderSandbox,
  type SandboxShared,
  type StoredSandboxRecord,
} from "./provider-sandbox.ts";
import type { Sandbox } from "./sandbox.ts";

const HOME_DIR = "/root";
const AGENT_PORT = 8080;
const SUSPENDED_SEC = 3600;
const DEFAULT_IDLE_PARK_SEC = 900;
const DEFAULT_MAX_LIFETIME_SEC = 28_800;
const ROTATE_MARGIN_SEC = 1800;
const TERMINATE_WAIT_MS = 60_000;

const DEFAULT_INGRESS = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
const DEFAULT_EGRESS = (region: string) =>
  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;

export interface StoredMicrovm extends StoredSandboxRecord {
  microvmId?: string;
  endpoint?: string;
  createdAtMs?: number;
}

export interface AwsSandboxOptions extends SandboxShared {
  region: string;
  profile?: string;
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArns?: string[];
  egressConnectorArns?: string[];
  store: DurableMap<StoredMicrovm>;
  api?: AwsMicrovmApi;
  fetchImpl?: typeof fetch;
}

interface Body {
  id: string;
  endpoint: string;
  createdAtMs: number;
}

export function createAwsSandbox(workspace: WorkspaceStore, opts: AwsSandboxOptions): Sandbox {
  const { region, store } = opts;
  const api =
    opts.api ??
    createMicrovmApi({
      region,
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  const client = createMicrovmClient(api, {
    agentPort: AGENT_PORT,
    tokenTtlMinutes: 30,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const ingress = opts.ingressConnectorArns?.length ? opts.ingressConnectorArns : [DEFAULT_INGRESS(region)];
  const egress = opts.egressConnectorArns?.length ? opts.egressConnectorArns : [DEFAULT_EGRESS(region)];
  const maxLifetimeSec = opts.maxLifetimeSec ?? DEFAULT_MAX_LIFETIME_SEC;
  const rotateAfterMs = Math.max(maxLifetimeSec - ROTATE_MARGIN_SEC, Math.floor(maxLifetimeSec * 0.9)) * 1000;

  const scratchPrefix = `${opts.namePrefix ?? "qm"}-scratch-`;
  const bodies = new Map<string, Body>();
  const scratch = new Set<string>();

  const fresh = (body: Body): boolean => Date.now() - body.createdAtMs < rotateAfterMs;

  async function bodyFor(name: string): Promise<{ scope?: string; body: Body | null }> {
    const cached = bodies.get(name);
    if (cached || scratch.has(name) || name.startsWith(scratchPrefix)) return { body: cached ?? null };
    const scope = await scopeOfName(sandbox, store, name);
    const rec = scope ? await store.get(scope) : null;
    if (!rec?.microvmId || !rec.endpoint) return { ...(scope ? { scope } : {}), body: null };
    const body = { id: rec.microvmId, endpoint: rec.endpoint, createdAtMs: rec.createdAtMs ?? 0 };
    bodies.set(name, body);
    return { ...(scope ? { scope } : {}), body };
  }

  async function live(name: string): Promise<Body> {
    const { body } = await bodyFor(name);
    if (!body) throw new Error(`aws microVM ${name}: not provisioned`);
    return body;
  }

  let resolvedImageArn: string | undefined;
  async function imageArn(): Promise<string> {
    if (resolvedImageArn) return resolvedImageArn;
    if (opts.imageIdentifier.startsWith("arn:")) return (resolvedImageArn = opts.imageIdentifier);
    const img = await api.findImage(opts.imageIdentifier);
    if (!img) throw new Error(`AWS sandbox image not found: ${opts.imageIdentifier}`);
    return (resolvedImageArn = img.imageArn);
  }

  async function terminate(id: string): Promise<void> {
    const desc = await api.tryGetMicrovm(id);
    if (!desc || desc.state === "TERMINATED") return;
    try {
      if (desc.state !== "TERMINATING") await api.terminate(id);
      await api.waitForState(id, "TERMINATED", { timeoutMs: TERMINATE_WAIT_MS });
    } catch (error) {
      if (!(error instanceof AwsApiError && error.status === 404)) throw error;
    }
  }

  function drop(name: string): void {
    const body = bodies.get(name);
    if (body) client.evict(body.id);
    bodies.delete(name);
    scratch.delete(name);
  }

  async function create(name: string, { scratch: isScratch }: { scratch: boolean }): Promise<void> {
    const scope = isScratch ? undefined : await scopeOfName(sandbox, store, name);
    const run = await api.runMicrovm({
      imageIdentifier: await imageArn(),
      ...(opts.imageVersion ? { imageVersion: opts.imageVersion } : {}),
      ingressNetworkConnectors: ingress,
      egressNetworkConnectors: egress,
      ...(opts.executionRoleArn ? { executionRoleArn: opts.executionRoleArn } : {}),
      idlePolicy: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: opts.idleParkSec ?? DEFAULT_IDLE_PARK_SEC,
        suspendedDurationSeconds: SUSPENDED_SEC,
      },
      maximumDurationInSeconds: maxLifetimeSec,
      clientToken: `${name}-${Date.now()}`,
    });
    const createdAtMs = Date.now();
    if (scope) {
      await store.putIfAbsent(scope, {});
      await store.merge(scope, { microvmId: run.microvmId, endpoint: run.endpoint ?? "", createdAtMs });
    }
    try {
      const ready = await api.waitForState(run.microvmId, "RUNNING");
      const endpoint = run.endpoint || ready.endpoint;
      if (!endpoint) throw new Error(`microVM ${run.microvmId} has no endpoint`);
      if (scope && endpoint !== run.endpoint) await store.merge(scope, { endpoint });
      await client.waitDaemon(run.microvmId, endpoint);
      bodies.set(name, { id: run.microvmId, endpoint, createdAtMs });
      if (isScratch) scratch.add(name);
    } catch (error) {
      try {
        await api.terminate(run.microvmId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `AWS launch ${run.microvmId} failed and termination failed`, {
          cause: cleanupError,
        });
      }
      throw error;
    }
  }

  async function destroy(name: string): Promise<void> {
    const { scope, body } = await bodyFor(name);
    if (body) await terminate(body.id);
    drop(name);
    if (scope && body) await store.merge(scope, { microvmId: undefined, endpoint: undefined, createdAtMs: undefined });
  }

  const sandbox: ProviderSandbox = createProviderSandbox(
    workspace,
    {
      backend: "aws",
      homeDir: HOME_DIR,
      os: "Amazon Linux 2023, glibc",
      tools: ["git", "curl", "wget", "jq", "unzip", "gnupg", "python3", "gh", "aws"],
      cpus: opts.cpus ?? 4,
      memoryMb: opts.memoryMb ?? 8192,
      diskGb: opts.diskGb ?? 8,
      writablePersistence: "resident_disk",
      egressEnforcement: "none",
      async exec(name, script, timeoutSec) {
        const body = await live(name);
        await client.ensureRunning(body.id, body.endpoint);
        return client.execRaw(body.id, body.endpoint, script, timeoutSec);
      },
      async writeAbsBytes(name, absPath, data) {
        const body = await live(name);
        await client.writeAbs(body.id, body.endpoint, absPath, data);
      },
      async readAbsBytes(name, absPath) {
        const body = await live(name);
        const res = await client.daemon(body.id, body.endpoint, "/read", { path: absPath });
        if (res.status === 404) return null;
        if (res.status !== 200)
          throw new Error(`microVM read ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
        return Buffer.from((JSON.parse(res.text) as { b64: string }).b64, "base64");
      },
      async inspect(name) {
        const { scope, body } = await bodyFor(name);
        if (!body) return null;
        const desc = await api.tryGetMicrovm(body.id);
        if (!desc || desc.state === "TERMINATED" || desc.state === "TERMINATING") {
          drop(name);
          if (scope) await store.merge(scope, { microvmId: undefined, endpoint: undefined, createdAtMs: undefined });
          return null;
        }
        const parked = desc.state === "SUSPENDED" || desc.state === "SUSPENDING";
        return {
          state: parked ? "parked" : "running",
          detail: `microVM ${body.id} ${desc.state}${desc.stateReason ? `: ${desc.stateReason}` : ""}`,
        };
      },
      async rotationDue(name) {
        const { body } = await bodyFor(name);
        return !!body && !fresh(body);
      },
      create,
      async resume(name) {
        const body = await live(name);
        await client.ensureRunning(body.id, body.endpoint);
      },
      async park(name, { keepWarm }) {
        if (keepWarm) return;
        await api.suspend((await live(name)).id);
      },
      destroy,
      isLive: (name) => scratch.has(name),
      forget: (name) => {
        if (!scratch.has(name)) drop(name);
      },
    },
    opts,
    store,
  );
  return sandbox;
}
