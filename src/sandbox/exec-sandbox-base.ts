import { randomUUID } from "node:crypto";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { shortHash } from "../util/crypto.ts";
import { DROPPED_PROXY_ENV, forceThroughProxyEnv, nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import type { LayerToolInstaller } from "./layer-tool-install.ts";
import { posixJoin } from "./exec-file-ops.ts";
import { ephemeralCredLinkScript, type CredentialPathSpec } from "../credentials/resident-paths.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { execFailureDetail } from "./sandbox.ts";
import type { ExecOptions, ExecResult, ProvisionOptions, SandboxHandle, TeardownOptions } from "./sandbox.ts";

const WORKSPACE_BASENAME = "workspace";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const PREP_TIMEOUT_SEC = 60;

export const sandboxScopeName = (prefix: string, id: string): string => {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
};

export interface ExecSandboxBaseDeps {
  workspace: WorkspaceStore;
  label: string;
  prefix: string;
  homeDir: string;
  defaultTimeoutSec: number;
  credentialPaths: CredentialPathSpec[];
  egressProxyUrl?: string;
  deleteFailureCode: string;
  onError?(e: { category: string; code: string; message: string; scopeLabel?: string }): void;
  exec(name: string, script: string, timeoutSec: number): Promise<ExecResult>;
  writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void>;
  readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null>;
  ensureResident(name: string, onStatus?: (text: string) => void): Promise<{ coldStart: boolean }>;
  isProvisioned(name: string): boolean;
  recreateScratch(name: string): Promise<void>;
  deleteInstance(name: string): Promise<void>;
  forgetInstance?(name: string): void;
  ensureEgress?(name: string): Promise<void>;
  installLayerTools?: LayerToolInstaller;
}

export interface ExecSandboxBase {
  workspaceDir: string;
  provisionQueue: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  scopeFor(name: string): string | undefined;
  provision(layers: WorkspaceLayer[], opts?: ProvisionOptions): Promise<SandboxHandle>;
  run(handle: SandboxHandle, command: string, opts?: ExecOptions): Promise<ExecResult>;
  writeFileBytes(handle: SandboxHandle, relPath: string, data: Uint8Array): Promise<void>;
  writeFile(handle: SandboxHandle, relPath: string, data: string): Promise<void>;
  readFileBytes(handle: SandboxHandle, relPath: string): Promise<Uint8Array | null>;
  readFile(handle: SandboxHandle, relPath: string): Promise<string | null>;
  teardown(handle: SandboxHandle, opts?: TeardownOptions): Promise<void>;
}

export function createExecSandboxBase(deps: ExecSandboxBaseDeps): ExecSandboxBase {
  const { workspace, label, prefix, homeDir, defaultTimeoutSec } = deps;
  if (deps.egressProxyUrl && !new URL(deps.egressProxyUrl).hostname) {
    throw new Error(`${label}-sandbox: egress proxy url has no hostname: ${deps.egressProxyUrl}`);
  }
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();
  const scopeByName = new Map<string, string>();
  const scratchKeyByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = sandboxScopeName(`${prefix}-scratch`, key);
    return provisionQueue(`scratch:${key}`, async () => {
      scratchKeyByName.set(name, key);
      const active = activeScratch.get(name) ?? 0;
      if (active === 0 && !deps.isProvisioned(name)) await deps.recreateScratch(name);
      activeScratch.set(name, active + 1);
      return { name, coldStart: active === 0 };
    });
  }

  async function writeFileBytes(handle: SandboxHandle, relPath: string, data: Uint8Array): Promise<void> {
    await deps.writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), data);
  }

  async function writeFile(handle: SandboxHandle, relPath: string, data: string): Promise<void> {
    await writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
  }

  async function readFileBytes(handle: SandboxHandle, relPath: string): Promise<Uint8Array | null> {
    return deps.readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath));
  }

  async function readFile(handle: SandboxHandle, relPath: string): Promise<string | null> {
    const bytes = await readFileBytes(handle, relPath);
    return bytes === null ? null : Buffer.from(bytes).toString("utf8");
  }

  async function teardown(handle: SandboxHandle, tdOpts?: TeardownOptions): Promise<void> {
    if (handle.scratch) {
      const key = scratchKeyByName.get(handle.id);
      return provisionQueue(key ? `scratch:${key}` : handle.id, async () => {
        const remaining = (activeScratch.get(handle.id) ?? 1) - 1;
        if (remaining > 0) {
          activeScratch.set(handle.id, remaining);
          return;
        }
        activeScratch.delete(handle.id);
        deps.forgetInstance?.(handle.id);
        if (tdOpts?.destroy) await deps.deleteInstance(handle.id);
        else await deps.deleteInstance(handle.id).catch(swallowAs(`${label}-sandbox: scratch delete`, undefined));
      });
    }
    if (!tdOpts?.destroy) return;
    deps.forgetInstance?.(handle.id);
    await deps.deleteInstance(handle.id).catch((e) => {
      const scope = scopeByName.get(handle.id);
      deps.onError?.({
        category: "sandbox_teardown",
        code: deps.deleteFailureCode,
        message: errMessage(e),
        ...(scope ? { scopeLabel: scope } : {}),
      });
    });
  }

  async function provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
    const scratch = provOpts?.scratch;
    const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
    const scope = writable?.scopeId ?? "default";
    let name: string;
    let coldStart: boolean;
    if (scratch) {
      ({ name, coldStart } = await ensureScratch(scratch.key));
    } else {
      name = sandboxScopeName(prefix, scope);
      scopeByName.set(name, scope);
      ({ coldStart } = await provisionQueue(scope, () => deps.ensureResident(name, provOpts?.onStatus)));
    }

    const handle: SandboxHandle = {
      id: name,
      rootDir: workspaceDir,
      homeDir,
      coldStart,
      ...(scratch ? { scratch: true } : {}),
    };

    try {
      const forceEgress = !!deps.egressProxyUrl && !!provOpts?.egressToken;
      if (forceEgress) await deps.ensureEgress?.(name);
      const turnEnv = Object.fromEntries(
        Object.entries(provOpts?.env ?? {}).filter(([k]) => !DROPPED_PROXY_ENV.has(k)),
      );
      const env = {
        ...turnEnv,
        ...(forceEgress ? forceThroughProxyEnv(deps.egressProxyUrl!, provOpts!.egressToken!) : {}),
      };
      if (Object.keys(env).length) handle.env = env;
      const credLinks = scratch ? "" : ` && ${ephemeralCredLinkScript(homeDir, deps.credentialPaths)}`;
      const prep = await deps.exec(name, `mkdir -p ${shq(workspaceDir)}${credLinks}`, PREP_TIMEOUT_SEC);
      if (prep.code !== 0)
        throw new Error(`${label} provision prep failed: ${execFailureDetail(prep, PREP_TIMEOUT_SEC).slice(0, 200)}`);

      await materializeRoLayers(
        workspace,
        layers,
        handle,
        {
          readFile,
          writeFileBytes,
          exec: (script, t) => deps.exec(name, script, t),
        },
        { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label },
      );
      await deps.installLayerTools?.({
        exec: (script, t) => deps.exec(name, script, t),
        writeAbs: (abs, data) => deps.writeAbsBytes(name, abs, data),
      });

      return handle;
    } catch (err) {
      await teardown(handle).catch(swallowAs(`${label}-sandbox: teardown after failed provision`, undefined));
      throw err;
    }
  }

  async function run(handle: SandboxHandle, command: string, execOpts?: ExecOptions): Promise<ExecResult> {
    const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
    const exports = Object.entries(handle.env ?? {})
      .map(([k, v]) => `export ${k}=${shq(v)}`)
      .join("; ");
    const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
    const signal = execOpts?.signal;
    if (!signal) return deps.exec(handle.id, script, timeoutSec);
    const killUid = randomUUID();
    const fireKill = () => {
      deps
        .exec(handle.id, killScript(killUid), 15)
        .catch(swallowAs(`${label}-sandbox: kill in-flight exec`, undefined));
    };
    signal.throwIfAborted();
    const onAbort = () => fireKill();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await deps.exec(handle.id, killableScript(script, killUid), timeoutSec);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    workspaceDir,
    provisionQueue,
    scopeFor: (name) => scopeByName.get(name),
    provision,
    run,
    writeFileBytes,
    writeFile,
    readFileBytes,
    readFile,
    teardown,
  };
}
