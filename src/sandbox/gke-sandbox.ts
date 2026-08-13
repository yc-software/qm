import { randomUUID } from "node:crypto";
import { CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { ephemeralCredLinkPaths, ephemeralCredLinkScript } from "../credentials/resident-paths.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { shortHash } from "../util/crypto.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createExecBackup, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";

const GROUP = "extensions.agents.x-k8s.io";
const VERSION = "v1alpha1";
const PLURAL = "sandboxclaims";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";

interface ClaimStatus {
  sandbox?: { name?: string };
  conditions?: Array<{ status?: string; type?: string; message?: string }>;
}

interface ClaimBody {
  status?: ClaimStatus;
}

interface CustomObjectsClient {
  createNamespacedCustomObject(
    group: string,
    version: string,
    namespace: string,
    plural: string,
    body: unknown,
  ): Promise<unknown>;
  deleteNamespacedCustomObject(
    group: string,
    version: string,
    namespace: string,
    plural: string,
    name: string,
  ): Promise<unknown>;
  getNamespacedCustomObject(
    group: string,
    version: string,
    namespace: string,
    plural: string,
    name: string,
  ): Promise<unknown>;
}

export interface GkeSandboxOptions {
  namespace: string;
  warmPool: string;
  routerUrl: string;
  routerToken?: string;
  agentPort?: number;
  defaultTimeoutSec?: number;
  homeDir?: string;
  claimTimeoutMs?: number;
  daemonReadyTimeoutMs?: number;
  extraTools?: string[];
  client?: CustomObjectsClient;
  fetchImpl?: typeof fetch;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

const bodyOf = <T>(value: unknown): T => ((value as { body?: unknown } | undefined)?.body ?? value) as T;

const statusCodeOf = (error: unknown): number | undefined => {
  const candidate = error as {
    statusCode?: number;
    response?: { statusCode?: number; status?: number };
    body?: { code?: number };
  };
  return (
    candidate?.statusCode ?? candidate?.response?.statusCode ?? candidate?.response?.status ?? candidate?.body?.code
  );
};

const claimNameFor = (scope: string): string => {
  const cleaned = scope
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/-+$/, "");
  return `qm-${cleaned || "scope"}-${shortHash(scope)}`;
};

const claimStatus = (value: unknown): ClaimStatus => bodyOf<ClaimBody>(value).status ?? {};

export function createGkeSandbox(workspace: WorkspaceStore, opts: GkeSandboxOptions): Sandbox {
  const namespace = opts.namespace;
  const agentPort = opts.agentPort ?? 8080;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const homeDir = opts.homeDir ?? "/home/agent";
  const workspaceDir = `${homeDir}/workspace`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const queue = createKeyedQueue<string>();
  const claimBySandbox = new Map<string, string>();
  const activeBySandbox = new Map<string, number>();
  const api =
    opts.client ??
    (() => {
      const config = new KubeConfig();
      config.loadFromDefault();
      return config.makeApiClient(CustomObjectsApi) as unknown as CustomObjectsClient;
    })();

  async function getClaim(name: string): Promise<unknown | null> {
    try {
      return await api.getNamespacedCustomObject(GROUP, VERSION, namespace, PLURAL, name);
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      throw error;
    }
  }

  async function ensureClaim(scope: string): Promise<{ claim: string; sandbox: string; coldStart: boolean }> {
    return queue(scope, async () => {
      const claim = claimNameFor(scope);
      let value = await getClaim(claim);
      const coldStart = value === null;
      if (value === null) {
        value = await api.createNamespacedCustomObject(GROUP, VERSION, namespace, PLURAL, {
          apiVersion: `${GROUP}/${VERSION}`,
          kind: "SandboxClaim",
          metadata: {
            name: claim,
            namespace,
            labels: {
              "app.kubernetes.io/managed-by": "qm",
              "simplelend.io/scope-hash": shortHash(scope),
            },
          },
          spec: {
            warmPoolRef: { name: opts.warmPool },
            additionalPodMetadata: {
              labels: {
                "sandbox.users.io/qm-claim": claim,
              },
            },
          },
        });
      }

      try {
        const deadline = Date.now() + (opts.claimTimeoutMs ?? 180_000);
        let last = claimStatus(value);
        while (Date.now() < deadline) {
          const sandbox = last.sandbox?.name;
          if (sandbox) {
            claimBySandbox.set(sandbox, claim);
            await waitDaemon(sandbox);
            activeBySandbox.set(sandbox, (activeBySandbox.get(sandbox) ?? 0) + 1);
            return { claim, sandbox, coldStart };
          }
          await sleep(500);
          const current = await getClaim(claim);
          if (!current) throw new Error(`GKE sandbox claim ${claim} disappeared while provisioning`);
          last = claimStatus(current);
        }
        const detail = last.conditions
          ?.map((condition) => condition.message)
          .filter(Boolean)
          .join("; ");
        throw new Error(`GKE sandbox claim ${claim} was not ready within the deadline${detail ? `: ${detail}` : ""}`);
      } catch (error) {
        for (const [sandbox, boundClaim] of claimBySandbox) {
          if (boundClaim === claim) claimBySandbox.delete(sandbox);
        }
        if (coldStart) {
          await api
            .deleteNamespacedCustomObject(GROUP, VERSION, namespace, PLURAL, claim)
            .catch(swallowAs("gke-sandbox: claim cleanup after provisioning failure", undefined));
        }
        throw error;
      }
    });
  }

  async function daemon(
    sandbox: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    const res = await fetchImpl(`${opts.routerUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-Sandbox-ID": sandbox,
        "X-Sandbox-Namespace": namespace,
        "X-Sandbox-Port": String(agentPort),
        ...(opts.routerToken ? { authorization: `Bearer ${opts.routerToken}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs ?? 30_000), ...(signal ? [signal] : [])]),
    });
    return { status: res.status, text: await res.text() };
  }

  async function waitDaemon(sandbox: string): Promise<void> {
    const deadline = Date.now() + (opts.daemonReadyTimeoutMs ?? 60_000);
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const response = await daemon(sandbox, "/health", undefined, 3000);
        if (response.status === 200) return;
        lastError = `http ${response.status}`;
      } catch (error) {
        lastError = errMessage(error);
      }
      await sleep(500);
    }
    throw new Error(`GKE sandbox ${sandbox} exec daemon never became reachable: ${lastError}`);
  }

  async function execRaw(
    sandbox: string,
    command: string,
    timeoutSec: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const response = await daemon(sandbox, "/exec", { cmd: command, timeoutSec }, (timeoutSec + 15) * 1000, signal);
    if (response.status !== 200) {
      throw new Error(`GKE sandbox exec failed (${response.status}): ${response.text.slice(0, 300)}`);
    }
    const result = JSON.parse(response.text) as ExecResult;
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.code,
      timedOut: Boolean(result.timedOut),
    };
  }

  async function writeAbsBytes(sandbox: string, path: string, data: Uint8Array): Promise<void> {
    const response = await daemon(sandbox, "/write", { path, b64: Buffer.from(data).toString("base64") }, 120_000);
    if (response.status !== 200) {
      throw new Error(`GKE sandbox write ${path} failed (${response.status}): ${response.text.slice(0, 200)}`);
    }
  }

  async function readAbsBytes(sandbox: string, path: string): Promise<Uint8Array | null> {
    const response = await daemon(sandbox, "/read", { path }, 120_000);
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(`GKE sandbox read ${path} failed (${response.status}): ${response.text.slice(0, 200)}`);
    }
    return Buffer.from((JSON.parse(response.text) as { b64: string }).b64, "base64");
  }

  const profile: AgentComputerProfile = {
    backend: "gke-agent-sandbox",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "ip_port",
    spec: {
      os: "Debian 12 under GKE Agent Sandbox with gVisor",
      runtimes: ["Node 24", "Python 3"],
      tools: ["git", "curl", "wget", "jq", "python3", "gh", ...(opts.extraTools ?? [])],
      notInstalled: ["gcloud", "kubectl", "flyctl", "glab"],
      homeDir,
      workdir: workspaceDir,
    },
  };

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      return execRaw(handle.id, command, timeoutSec);
    },
  };
  const procSessions = createExecProcessSessions(procIo);
  const execFileOps = createExecFileOps({
    label: "gke",
    exec: (id, script, timeout) => execRaw(id, script, timeout),
    writeInline: (id, path, data) => writeAbsBytes(id, path, data),
  });
  const execBackup = createExecBackup({
    label: "gke",
    exec: (id, script, timeout) => execRaw(id, script, timeout),
    readAbsBytes,
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths().map(({ rel }) => rel),
  });

  const sandbox: Sandbox = {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,

    async provision(layers: WorkspaceLayer[], provisionOptions?: ProvisionOptions): Promise<SandboxHandle> {
      const writable = layers.find((layer) => layer.mode === "rw") ?? layers[0];
      const scope = provisionOptions?.scratch
        ? `scratch:${provisionOptions.scratch.key}`
        : (writable?.scopeId ?? "default");
      const body = await ensureClaim(scope);
      const env = provisionOptions?.env && Object.keys(provisionOptions.env).length ? provisionOptions.env : undefined;
      const handle: SandboxHandle = {
        id: body.sandbox,
        rootDir: workspaceDir,
        homeDir,
        coldStart: body.coldStart,
        backend: "gke",
        scopeId: scope,
        ...(provisionOptions?.scratch ? { scratch: true } : {}),
        ...(env ? { env } : {}),
      };

      try {
        const prep = await execRaw(
          body.sandbox,
          `mkdir -p ${shq(workspaceDir)} && ${ephemeralCredLinkScript(homeDir)}`,
          30,
        );
        if (prep.code !== 0) throw new Error(`GKE sandbox provision prep failed: ${prep.stderr.slice(0, 200)}`);
        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (current, path) => sandbox.readFile(current, path),
            writeFileBytes: (current, path, data) => sandbox.writeFileBytes(current, path, data),
            exec: (script, timeout) => execRaw(body.sandbox, script, timeout),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "gke" },
        );
        return handle;
      } catch (error) {
        await sandbox
          .teardown(handle, { destroy: true })
          .catch(swallowAs("gke-sandbox: teardown after failed provision", undefined));
        throw error;
      }
    },

    async run(handle, command, execOptions?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOptions?.timeoutMs ? Math.ceil(execOptions.timeoutMs / 1000) : defaultTimeoutSec;
      const exports = Object.entries(handle.env ?? {})
        .map(([name, value]) => `export ${name}=${shq(value)}`)
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? `${exports}; ` : ""}cd ${shq(handle.rootDir)} 2>/dev/null; ${command}`;
      if (!execOptions?.signal) return execRaw(handle.id, script, timeoutSec);
      const killUid = randomUUID();
      const fireKill = () => {
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("gke-sandbox: kill in-flight exec", undefined));
      };
      if (execOptions.signal.aborted) fireKill();
      execOptions.signal.addEventListener("abort", fireKill, { once: true });
      try {
        return await execRaw(handle.id, killableScript(script, killUid), timeoutSec, execOptions.signal);
      } finally {
        execOptions.signal.removeEventListener("abort", fireKill);
      }
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), data);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const data = await readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath));
      return data === null ? null : Buffer.from(data).toString("utf8");
    },
    backupComputer: execBackup.backupComputer,

    async teardown(handle, teardownOptions?: TeardownOptions): Promise<void> {
      const remaining = (activeBySandbox.get(handle.id) ?? 1) - 1;
      if (remaining > 0) {
        activeBySandbox.set(handle.id, remaining);
        return;
      }
      activeBySandbox.delete(handle.id);
      if (!teardownOptions?.destroy) return;
      const claim = claimBySandbox.get(handle.id);
      if (!claim) return;
      try {
        await api.deleteNamespacedCustomObject(GROUP, VERSION, namespace, PLURAL, claim);
      } catch (error) {
        if (statusCodeOf(error) !== 404) {
          opts.onError?.({
            category: "sandbox_teardown",
            code: "gke_claim_delete_failed",
            message: errMessage(error),
            ...(handle.scopeId ? { scopeLabel: handle.scopeId } : {}),
          });
          throw error;
        }
      } finally {
        claimBySandbox.delete(handle.id);
      }
    },
  };

  return sandbox;
}
