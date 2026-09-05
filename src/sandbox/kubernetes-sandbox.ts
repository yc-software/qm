import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { ephemeralCredLinkPaths, ephemeralCredLinkScript } from "../credentials/resident-paths.ts";
import { spawnCommandExec, type CommandExec } from "./command-exec.ts";
import { createExecFileOps, createExecBackup, posixJoin } from "./exec-file-ops.ts";
import { createExecProcessSessions } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import type { WorkspaceLayer } from "../types.ts";
import type { Sandbox, SandboxHandle, ExecResult } from "./sandbox.ts";

export interface KubernetesSandboxOptions {
  orgId: string;
  namespace: string;
  image: string;
  coreNamespace: string;
  runtimeClassName?: string;
  storageClassName?: string;
  storageSize?: string;
  kubectlBin?: string;
  readyTimeoutSec?: number;
  cpus?: number;
  memoryMb?: number;
  commandExec?: CommandExec;
  fetchImpl?: typeof fetch;
}

const HOME = "/root";
type ResourceKind = "Pod" | "PersistentVolumeClaim" | "NetworkPolicy";

interface KubernetesResource {
  apiVersion: string;
  kind: ResourceKind;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    deletionTimestamp?: string;
  };
  spec?: Record<string, unknown>;
  status?: { phase?: string; podIP?: string; conditions?: { type: string; status: string }[] };
}

const RESOURCE_COLLECTIONS: Record<ResourceKind, string> = {
  Pod: "pods",
  PersistentVolumeClaim: "persistentvolumeclaims",
  NetworkPolicy: "networkpolicies",
};

const OWNER = "qm.dev/sandbox-owner";
const SCOPE = "qm.dev/sandbox-scope";
const CONFIG = "qm.dev/sandbox-config";
const MANAGED = "qm.dev/sandbox";
const WORKSPACE = `${HOME}/workspace`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

export function createKubernetesSandbox(workspace: WorkspaceStore, opts: KubernetesSandboxOptions): Sandbox {
  validateOptions(opts);
  const exec = opts.commandExec ?? spawnCommandExec(opts.kubectlBin ?? "kubectl");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const readyTimeoutSec = opts.readyTimeoutSec ?? 180;
  const timeoutMs = readyTimeoutSec * 1000;
  const owner = hash(opts.orgId);
  const queue = createKeyedQueue<string>();
  const active = new Map<string, number>();
  const fingerprint = hash(
    JSON.stringify({
      image: opts.image,
      runtime: opts.runtimeClassName,
      cpus: opts.cpus,
      memory: opts.memoryMb,
      coreNamespace: opts.coreNamespace,
    }),
  );

  async function kubectl(args: string[], input?: unknown): Promise<string> {
    const result = await exec(
      ["--namespace", opts.namespace, ...args],
      timeoutMs,
      input === undefined ? undefined : JSON.stringify(input),
    );
    if (result.code !== 0)
      throw new Error(`kubectl ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout;
  }

  function assertOwned(resource: KubernetesResource, name: string): void {
    if (
      resource.metadata.name !== name ||
      resource.metadata.labels?.[OWNER] !== owner ||
      resource.metadata.labels?.[MANAGED] !== "true"
    ) {
      throw new Error(`refusing unowned Kubernetes resource ${name}`);
    }
  }

  async function getResource(kind: ResourceKind, name: string): Promise<KubernetesResource | null> {
    if (!/^qm-k8s-[a-f0-9]{32}$/.test(name)) throw new Error("invalid Kubernetes sandbox handle");
    const raw = await kubectl(["get", kind, name, "--ignore-not-found", "-o", "json"]);
    if (!raw.trim()) return null;
    const resource = JSON.parse(raw) as KubernetesResource;
    assertOwned(resource, name);
    return resource;
  }

  async function createResourceIfMissing(resource: KubernetesResource): Promise<boolean> {
    const existing = await getResource(resource.kind, resource.metadata.name);
    if (existing) {
      if (existing.metadata.annotations?.[SCOPE] !== resource.metadata.annotations?.[SCOPE])
        throw new Error("Kubernetes sandbox scope mismatch");
      if (existing.metadata.deletionTimestamp) throw new Error("Kubernetes sandbox resource is still terminating");
      if (resource.kind === "NetworkPolicy" && existing.metadata.annotations?.[CONFIG] !== fingerprint) {
        throw new Error(
          "Kubernetes sandbox configuration changed; drain sandboxes and remove their NetworkPolicies before restarting core",
        );
      }
      return false;
    }
    await kubectl(["create", "-f", "-"], resource);
    return true;
  }

  async function deleteResource(kind: ResourceKind, name: string): Promise<void> {
    const resource = await getResource(kind, name);
    if (!resource) return;
    if (!resource.metadata.uid) throw new Error("Kubernetes resource has no UID");
    const collection = RESOURCE_COLLECTIONS[kind];
    const prefix = kind === "NetworkPolicy" ? "/apis/networking.k8s.io/v1" : "/api/v1";
    await kubectl(["delete", "--raw", `${prefix}/namespaces/${opts.namespace}/${collection}/${name}`, "-f", "-"], {
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: resource.metadata.uid },
    });
    await kubectl(["wait", "--for=delete", `${kind}/${name}`, `--timeout=${readyTimeoutSec}s`]);
  }

  async function endpoint(name: string): Promise<string> {
    const pod = await getResource("Pod", name);
    if (
      !pod ||
      pod.metadata.deletionTimestamp ||
      pod.status?.phase !== "Running" ||
      !pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True")
    ) {
      throw new Error(`Kubernetes sandbox ${name} is not ready; provision it again`);
    }
    const ip = pod.status.podIP;
    if (!ip || !isIP(ip)) throw new Error("Kubernetes sandbox has no valid Pod IP");
    return `http://${isIP(ip) === 6 ? `[${ip}]` : ip}:8080`;
  }

  async function daemon(
    name: string,
    path: string,
    body?: unknown,
    timeout = 30_000,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetchImpl(`${await endpoint(name)}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    });
  }

  async function execRaw(name: string, command: string, seconds: number, signal?: AbortSignal): Promise<ExecResult> {
    const id = randomUUID();
    const kill = async () => {
      const response = await daemon(name, "/exec", { cmd: killScript(id), timeoutSec: 15 });
      if (!response.ok) throw new Error(`Kubernetes sandbox process cleanup failed (${response.status})`);
      const result = (await response.json()) as ExecResult;
      if (result.code !== 0 || result.timedOut) throw new Error("Kubernetes sandbox process cleanup failed");
    };
    let cleanup = true;
    try {
      signal?.throwIfAborted();
      const response = await daemon(
        name,
        "/exec",
        { cmd: killableScript(command, id), timeoutSec: seconds },
        (seconds + 15) * 1000,
        signal,
      );
      if (!response.ok) throw new Error(`Kubernetes sandbox exec failed (${response.status})`);
      const result = (await response.json()) as ExecResult;
      cleanup = result.timedOut;
      return result;
    } finally {
      if (cleanup) await kill();
    }
  }

  async function write(name: string, path: string, bytes: Uint8Array): Promise<void> {
    const response = await daemon(name, "/write", { path, b64: Buffer.from(bytes).toString("base64") }, 120_000);
    if (!response.ok) throw new Error(`Kubernetes sandbox write failed (${response.status})`);
  }

  async function read(name: string, path: string): Promise<Uint8Array | null> {
    const response = await daemon(name, "/read", { path }, 120_000);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Kubernetes sandbox read failed (${response.status})`);
    return Buffer.from(((await response.json()) as { b64: string }).b64, "base64");
  }

  async function createOrReplacePod(manifest: KubernetesResource): Promise<boolean> {
    const name = manifest.metadata.name;
    let pod = await getResource("Pod", name);
    if (
      pod &&
      (pod.status?.phase === "Failed" ||
        pod.status?.phase === "Succeeded" ||
        pod.metadata.annotations?.[CONFIG] !== fingerprint)
    ) {
      if (active.has(name)) throw new Error("cannot replace an active Kubernetes sandbox");
      await deleteResource("Pod", name);
      pod = null;
    }
    return pod ? false : createResourceIfMissing(manifest);
  }

  async function prepareWorkspace(handle: SandboxHandle, layers: WorkspaceLayer[]): Promise<void> {
    const name = handle.id;
    await kubectl(["wait", "--for=condition=Ready", `Pod/${name}`, `--timeout=${readyTimeoutSec}s`]);
    const health = await daemon(name, "/health");
    if (!health.ok) throw new Error(`Kubernetes sandbox health failed (${health.status})`);
    const prep = await execRaw(name, `mkdir -p ${shq(WORKSPACE)} && ${ephemeralCredLinkScript(HOME)}`, 30);
    if (prep.code !== 0) throw new Error(`Kubernetes sandbox initialization failed: ${prep.stderr}`);
    await materializeRoLayers(
      workspace,
      layers,
      handle,
      {
        readFile: (h, path) => sandbox.readFile(h, path),
        writeFileBytes: (h, path, bytes) => sandbox.writeFileBytes(h, path, bytes),
        exec: (script, seconds) => execRaw(name, script, seconds),
      },
      { manifest: ".ro-layers.manifest", tar: ".ro-layers.tar", label: "kubernetes" },
    );
  }

  const sandbox: Sandbox = {
    profile: {
      backend: "kubernetes",
      writablePersistence: "resident_disk",
      processSessions: true,
      egressEnforcement: "none",
      spec: { os: "Linux container image on Kubernetes", homeDir: HOME, workdir: WORKSPACE },
    },
    ...createExecFileOps({ label: "kubernetes", exec: execRaw, writeInline: write }),
    ...createExecBackup({
      label: "kubernetes",
      exec: execRaw,
      readAbsBytes: read,
      defaultHomeDir: HOME,
      ephemeralCredentialPrefixes: ephemeralCredLinkPaths().map(({ rel }) => rel),
    }),
    ...createExecProcessSessions({
      run: (handle, command, options) =>
        execRaw(handle.id, command, Math.ceil((options?.timeoutMs ?? 600_000) / 1000), options?.signal),
    }),

    async provision(layers, options) {
      const scope = (layers.find((layer) => layer.mode === "rw") ?? layers[0])?.scopeId ?? "default";
      const identity = JSON.stringify([
        opts.orgId,
        options?.scratch ? "scratch" : "resident",
        options?.scratch?.key ?? scope,
      ]);
      const name = `qm-k8s-${hash(identity)}`;
      return queue(name, async () => {
        let createdPod = false;
        let createdPolicy = false;
        try {
          const labels = { [OWNER]: owner, [MANAGED]: "true", "qm.dev/sandbox-id": name };
          const metadata = {
            name,
            namespace: opts.namespace,
            labels,
            annotations: { [SCOPE]: hash(identity), [CONFIG]: fingerprint },
          };
          const { policy, volume, pod } = buildSandboxResources(opts, metadata, !!options?.scratch);
          createdPolicy = await createResourceIfMissing(policy);
          const coldStart = options?.scratch ? true : await createResourceIfMissing(volume);
          createdPod = await createOrReplacePod(pod);
          const handle = {
            id: name,
            rootDir: WORKSPACE,
            homeDir: HOME,
            coldStart,
            scopeId: scope,
            ...(options?.env ? { env: options.env } : {}),
            ...(options?.scratch ? { scratch: true } : {}),
          };
          await prepareWorkspace(handle, layers);
          active.set(name, (active.get(name) ?? 0) + 1);
          return handle;
        } catch (error) {
          if (createdPod)
            await deleteResource("Pod", name).catch(swallowAs("kubernetes: failed provision Pod cleanup", undefined));
          if (createdPolicy && !(await getResource("Pod", name)))
            await deleteResource("NetworkPolicy", name).catch(
              swallowAs("kubernetes: failed provision policy cleanup", undefined),
            );
          throw error;
        }
      });
    },

    async run(handle, command, options) {
      const seconds = Math.ceil((options?.timeoutMs ?? 600_000) / 1000);
      const exports = Object.entries(handle.env ?? {})
        .map(([key, value]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("invalid sandbox environment key");
          return `export ${key}=${shq(value)}`;
        })
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? `${exports}; ` : ""}cd ${shq(handle.rootDir)} && ${command}`;
      return execRaw(handle.id, script, seconds, options?.signal);
    },
    async writeFileBytes(handle, path, bytes) {
      await write(handle.id, posixJoin(handle.rootDir, path), bytes);
    },
    async writeFile(handle, path, text) {
      await sandbox.writeFileBytes(handle, path, Buffer.from(text));
    },
    async readFileBytes(handle, path) {
      return read(handle.id, posixJoin(handle.rootDir, path));
    },
    async readFile(handle, path) {
      const bytes = await sandbox.readFileBytes(handle, path);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },
    async teardown(handle, options) {
      await queue(handle.id, async () => {
        const remaining = (active.get(handle.id) ?? 1) - 1;
        if (remaining > 0) {
          active.set(handle.id, remaining);
          return;
        }
        active.delete(handle.id);
        if (options?.keepWarm && !options.destroy && !handle.scratch) return;
        await deleteResource("Pod", handle.id);
        if (options?.destroy && !handle.scratch) await deleteResource("PersistentVolumeClaim", handle.id);
        await deleteResource("NetworkPolicy", handle.id);
      });
    },
  };
  return sandbox;
}

function validateOptions(opts: KubernetesSandboxOptions): void {
  const label = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
  for (const [name, value] of [
    ["namespace", opts.namespace],
    ["coreNamespace", opts.coreNamespace],
  ] as const) {
    if (!value || value.length > 63 || !label.test(value)) throw new Error(`invalid Kubernetes ${name}`);
  }
  if (!opts.orgId || !opts.image.trim()) throw new Error("Kubernetes sandbox requires orgId and image");
  for (const [name, value] of [
    ["cpus", opts.cpus],
    ["memoryMb", opts.memoryMb],
    ["readyTimeoutSec", opts.readyTimeoutSec],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`invalid Kubernetes ${name}`);
  }
}

function buildSandboxResources(
  opts: KubernetesSandboxOptions,
  metadata: KubernetesResource["metadata"],
  scratch: boolean,
): { policy: KubernetesResource; volume: KubernetesResource; pod: KubernetesResource } {
  const name = metadata.name;
  const limits = { cpu: String(opts.cpus ?? 1), memory: `${opts.memoryMb ?? 1024}Mi` };
  const policy: KubernetesResource = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata,
    spec: {
      podSelector: { matchLabels: { "qm.dev/sandbox-id": name } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": opts.coreNamespace } },
              podSelector: { matchLabels: { "qm.dev/sandbox-client": "true" } },
            },
          ],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
    },
  };
  const volume: KubernetesResource = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata,
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: opts.storageSize ?? "10Gi" } },
      ...(opts.storageClassName ? { storageClassName: opts.storageClassName } : {}),
    },
  };
  const pod: KubernetesResource = {
    apiVersion: "v1",
    kind: "Pod",
    metadata,
    spec: {
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      enableServiceLinks: false,
      ...(opts.runtimeClassName ? { runtimeClassName: opts.runtimeClassName } : {}),
      nodeSelector: { "kubernetes.io/arch": "amd64" },
      securityContext: { seccompProfile: { type: "RuntimeDefault" } },
      containers: [
        {
          name: "sandbox",
          image: opts.image,
          imagePullPolicy: "IfNotPresent",
          env: [{ name: "HOME", value: HOME }],
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          resources: { requests: limits, limits },
          readinessProbe: { httpGet: { path: "/health", port: 8080 } },
          volumeMounts: [
            { name: "home", mountPath: HOME },
            { name: "processes", mountPath: `${HOME}/.agent-proc` },
          ],
        },
      ],
      volumes: [
        { name: "processes", emptyDir: {} },
        {
          name: "home",
          ...(scratch ? { emptyDir: {} } : { persistentVolumeClaim: { claimName: name } }),
        },
      ],
    },
  };
  return { policy, volume, pod };
}
