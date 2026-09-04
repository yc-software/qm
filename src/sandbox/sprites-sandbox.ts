import { randomUUID } from "node:crypto";
import { SpritesClient } from "@fly/sprites";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import {
  BLOB_TRANSFER_TTL_MS,
  createExecBackup,
  createExecBlobStaging,
  createExecFileOps,
  posixJoin,
} from "./exec-file-ops.ts";
import { ephemeralCredLinkScript, type CredentialPathSpec } from "../credentials/resident-paths.ts";
import { DROPPED_PROXY_ENV, forceThroughProxyEnv, proxyExportPrefix } from "./sandbox-env.ts";
import { BLOB_TRANSFER_AUD, mintCapabilityToken } from "../auth/capability-token.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { CAPABILITY_HEADER } from "../api/contract.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import { shortHash } from "../util/crypto.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { visibleNotInstalled, visibleTools } from "./sandbox.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";

const HOME_DIR = "/home/sprite";
const WORKSPACE_BASENAME = "workspace";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const MISSING_RC = 44;
const READ_CHUNK = 512 * 1024;
const EXIT_GRACE_MS = 60_000;
const RESTART_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 30_000;
const GUEST_PROBE_TIMEOUT_SEC = 15;
const DEFAULT_SPRITES_BASE_URL = "https://api.sprites.dev";

export interface SpritesClientLike {
  getSprite(name: string): Promise<unknown>;
  createSprite(name: string): Promise<unknown>;
  deleteSprite(name: string): Promise<void>;
}

export interface SpritesSandboxOptions {
  token?: string;
  baseUrl?: string;
  namePrefix?: string;
  defaultTimeoutSec?: number;
  egressProxyUrl?: string;
  blobTransfer?: BlobTransferStore;
  signingSecret?: string;
  capabilitySecret?: string;
  apiBaseUrl?: string;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  client?: SpritesClientLike;
  fetchImpl?: typeof fetch;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export const spriteScopeName = (prefix: string, id: string): string => {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
};

export function createSpritesSandbox(workspace: WorkspaceStore, opts: SpritesSandboxOptions = {}): Sandbox {
  if ((!opts.client || !opts.fetchImpl) && !opts.token)
    throw new Error("SANDBOX_BACKEND=sprites requires SPRITES_TOKEN");
  const client: SpritesClientLike =
    opts.client ?? (new SpritesClient(opts.token!, opts.baseUrl ? { baseURL: opts.baseUrl } : {}) as SpritesClientLike);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_SPRITES_BASE_URL).replace(/\/+$/, "");
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const workspaceDir = `${HOME_DIR}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();

  const ensured = new Set<string>();
  const scopeByName = new Map<string, string>();
  const scratchKeyByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  interface RawExec {
    rc: number;
    stdout: Buffer;
    stderr: Buffer;
  }

  async function postExec(name: string, argv: string[], timeoutSec: number, body?: Uint8Array): Promise<RawExec> {
    const qs = new URLSearchParams();
    if (body) qs.append("stdin", "true");
    for (const a of argv) qs.append("cmd", a);
    const res = await fetchImpl(`${baseUrl}/v1/sprites/${encodeURIComponent(name)}/exec?${qs}`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token ?? ""}`, "content-type": "application/octet-stream" },
      ...(body ? { body: Buffer.from(body) } : {}),
      signal: AbortSignal.timeout(timeoutSec * 1000 + EXIT_GRACE_MS),
    });
    if (!res.ok) throw new Error(`sprites exec ${name}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    const raw = Buffer.from(await res.arrayBuffer());
    let rc = 0;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let i = 0;
    while (i < raw.length) {
      const id = raw[i]!;
      if (id === 3) {
        rc = raw[i + 1] ?? 0;
        i += 2;
        continue;
      }
      i++;
      const start = i;
      while (i < raw.length && raw[i]! >= 4) i++;
      const payload = raw.subarray(start, i);
      if (id === 1) out.push(payload);
      else if (id === 2) err.push(payload);
    }
    return { rc, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
  }

  async function execRaw(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const uid = randomUUID();
    const out = `/tmp/.exec-${uid}.out`;
    const err = `/tmp/.exec-${uid}.err`;
    const wrapped = `timeout ${timeoutSec} sh -c ${shq(script)} > ${out} 2> ${err}; __rc=$?; printf '%s %s %s\\n' "$__rc" "$(wc -c < ${out})" "$(wc -c < ${err})"; base64 < ${out}; base64 < ${err}; rm -f ${out} ${err}`;
    const r = await postExec(name, ["sh", "-c", wrapped], timeoutSec);
    const text = r.stdout.toString("utf8");
    const nl = text.indexOf("\n");
    const header = text
      .slice(0, nl < 0 ? undefined : nl)
      .trim()
      .split(/\s+/);
    if (r.rc !== 0 || nl < 0 || header.length !== 3) {
      throw new Error(`sprites exec ${name}: bad envelope (rc=${r.rc}): ${text.slice(0, 120)}`);
    }
    const code = Number.parseInt(header[0]!, 10);
    const outLen = Number.parseInt(header[1]!, 10);
    const errLen = Number.parseInt(header[2]!, 10);
    const b64 = text.slice(nl + 1).replace(/\s+/g, "");
    const outB64 = Math.ceil(outLen / 3) * 4;
    const outBuf = Buffer.from(b64.slice(0, outB64), "base64");
    const errBuf = Buffer.from(b64.slice(outB64), "base64");
    if (outBuf.length !== outLen || errBuf.length !== errLen) {
      throw new Error(
        `sprites exec ${name}: truncated stream (${outBuf.length}/${outLen} out, ${errBuf.length}/${errLen} err)`,
      );
    }
    return { stdout: outBuf.toString("utf8"), stderr: errBuf.toString("utf8"), code, timedOut: code === 124 };
  }

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    const tmp = `${absPath}.part.${randomUUID()}`;
    const script =
      `mkdir -p "$(dirname ${shq(absPath)})" && cat > ${shq(tmp)} && ` +
      `mv -f ${shq(tmp)} ${shq(absPath)} && wc -c < ${shq(absPath)}`;
    const r = await postExec(name, ["sh", "-c", script], 120, data);
    const written = Number.parseInt(r.stdout.toString("utf8").trim(), 10);
    if (r.rc !== 0 || written !== data.length) {
      throw new Error(
        `sprites write ${absPath} failed (rc=${r.rc}, ${Number.isFinite(written) ? written : 0}/${data.length} bytes)`,
      );
    }
  }

  const egressProxyHost = opts.egressProxyUrl ? new URL(opts.egressProxyUrl).hostname : undefined;
  const egressPolicyByName = new Map<string, string>();

  async function ensureEgressPolicy(name: string): Promise<void> {
    const rules = [{ domain: egressProxyHost!, action: "allow" }];
    const want = JSON.stringify(rules);
    if (egressPolicyByName.get(name) === want) return;
    const url = `${baseUrl}/v1/sprites/${encodeURIComponent(name)}/policy/network`;
    const headers = { authorization: `Bearer ${opts.token ?? ""}`, "content-type": "application/json" };
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ rules }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
      throw new Error(`sprites egress policy ${name}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    const check = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
    const got = (await check.json().catch(() => null)) as {
      rules?: Array<{ domain?: string; action?: string }>;
    } | null;
    const norm = (d?: string) => (d ?? "").toLowerCase().replace(/\.$/, "");
    const only = got?.rules?.length === 1 ? got.rules[0] : undefined;
    const bound = !!only && norm(only.domain) === norm(egressProxyHost) && only.action?.toLowerCase() === "allow";
    if (!check.ok || !bound)
      throw new Error(`sprites egress policy ${name}: readback mismatch (${JSON.stringify(got).slice(0, 200)})`);
    egressPolicyByName.set(name, want);
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    const script =
      `[ -e ${shq(absPath)} ] || exit ${MISSING_RC}; s=$(wc -c < ${shq(absPath)}); echo "$s"; ` +
      `if [ "$s" -le ${READ_CHUNK} ]; then base64 < ${shq(absPath)}; fi`;
    const r = await postExec(name, ["sh", "-c", script], 120);
    if (r.rc === MISSING_RC) return null;
    const text = r.stdout.toString("utf8");
    if (r.rc !== 0) throw new Error(`sprites read ${absPath} failed (${r.rc}): ${text.slice(0, 200)}`);
    const nl = text.indexOf("\n");
    const declared = Number.parseInt(text.slice(0, nl < 0 ? undefined : nl).trim(), 10);
    if (!Number.isFinite(declared)) throw new Error(`sprites read ${absPath}: bad size (${text.slice(0, 40)})`);
    const parts: Buffer[] = [];
    if (declared <= READ_CHUNK) {
      parts.push(Buffer.from(text.slice(nl + 1).replace(/\s+/g, ""), "base64"));
    } else {
      for (let i = 0; i < Math.ceil(declared / READ_CHUNK); i++) {
        const chunk = `dd if=${shq(absPath)} bs=${READ_CHUNK} skip=${i} count=1 2>/dev/null | base64`;
        const c = await postExec(name, ["sh", "-c", chunk], 120);
        if (c.rc !== 0) throw new Error(`sprites read ${absPath} chunk ${i} failed (${c.rc})`);
        parts.push(Buffer.from(c.stdout.toString("utf8").replace(/\s+/g, ""), "base64"));
      }
    }
    const data = Buffer.concat(parts);
    if (data.length !== declared) {
      throw new Error(`sprites read ${absPath}: truncated (${data.length}/${declared})`);
    }
    return data;
  }

  async function ensureSprite(
    key: string,
    name: string,
    onStatus?: (text: string) => void,
  ): Promise<{ coldStart: boolean }> {
    return provisionQueue(key, async () => {
      if (ensured.has(name)) return { coldStart: false };
      let exists = false;
      try {
        await client.getSprite(name);
        exists = true;
      } catch (error) {
        void error;
      }
      if (!exists) {
        try {
          onStatus?.("Creating the sandbox…");
        } catch (error) {
          void error;
        }
        try {
          await client.createSprite(name);
          ensured.add(name);
          return { coldStart: true };
        } catch (createErr) {
          try {
            await client.getSprite(name);
          } catch {
            throw createErr;
          }
        }
      }
      ensured.add(name);
      return { coldStart: false };
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = spriteScopeName(`${prefix}-scratch`, key);
    return provisionQueue(`scratch:${key}`, async () => {
      scratchKeyByName.set(name, key);
      const active = activeScratch.get(name) ?? 0;
      if (active === 0 && !ensured.has(name)) {
        let stale = true;
        try {
          await client.getSprite(name);
        } catch {
          stale = false;
        }
        if (stale) await client.deleteSprite(name).catch(swallowAs("sprites-sandbox: stale scratch delete", undefined));
        await client.createSprite(name);
        ensured.add(name);
      }
      activeScratch.set(name, active + 1);
      return { name, coldStart: active === 0 };
    });
  }

  const profile: AgentComputerProfile = {
    backend: "sprites",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
    spec: {
      os: "Ubuntu 26.04 LTS — Fly Sprite microVM (auto-sleeps when idle; the whole disk persists)",
      runtimes: ["Node 24", "Python 3"],
      get tools() {
        return visibleTools(["git", "curl", "jq", "tar", "python3", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gh", "aws", "gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
      diskGb: 100,
      homeDir: HOME_DIR,
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
    label: "sprites",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const blobSigningSecret = opts.capabilitySecret ?? opts.signingSecret;
  const blobStaging =
    opts.blobTransfer && blobSigningSecret && opts.apiBaseUrl
      ? createExecBlobStaging({
          label: "sprites",
          exec: (id, script, t) => execRaw(id, script, t),
          proxyPrefix: proxyExportPrefix,
          apiBaseUrl: opts.apiBaseUrl,
          capabilityHeader: CAPABILITY_HEADER,
          mintToken: (grant) =>
            mintCapabilityToken(
              {
                actorId: "sprites-sandbox",
                aud: BLOB_TRANSFER_AUD,
                scopeId: "personal:sprites-sandbox",
                blob: grant,
                exp: Date.now() + BLOB_TRANSFER_TTL_MS,
              },
              blobSigningSecret,
            ),
        })
      : null;

  const execBackup = createExecBackup({
    label: "sprites",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: HOME_DIR,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  const sandbox: Sandbox = {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,
    ...(blobStaging
      ? {
          async stageIn(handle: SandboxHandle, destRelPath: string, blobId: string): Promise<void> {
            await blobStaging.stageInAbs(handle, posixJoin(handle.rootDir, destRelPath), blobId);
          },
          async stageOut(handle: SandboxHandle, srcRelPath: string): Promise<string> {
            return blobStaging.stageOutAbs(handle, posixJoin(handle.rootDir, srcRelPath));
          },
        }
      : {}),

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = writable?.scopeId ?? "default";
      let name: string;
      let coldStart: boolean;
      if (scratch) {
        ({ name, coldStart } = await ensureScratch(scratch.key));
      } else {
        name = spriteScopeName(prefix, scope);
        scopeByName.set(name, scope);
        ({ coldStart } = await ensureSprite(scope, name, provOpts?.onStatus));
      }

      const forceEgress = !!egressProxyHost && !!provOpts?.egressToken;
      if (forceEgress) await ensureEgressPolicy(name);
      const turnEnv = Object.fromEntries(
        Object.entries(provOpts?.env ?? {}).filter(([k]) => !DROPPED_PROXY_ENV.has(k)),
      );
      const env = {
        ...turnEnv,
        ...(forceEgress ? forceThroughProxyEnv(opts.egressProxyUrl!, provOpts!.egressToken!) : {}),
      };
      const handle: SandboxHandle = {
        id: name,
        rootDir: workspaceDir,
        homeDir: HOME_DIR,
        coldStart,
        ...(scratch ? { scratch: true } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };

      try {
        // Scratch boxes are credential-free and wiped at release; they don't get the links.
        const credLinks = scratch ? "" : ` && ${ephemeralCredLinkScript(HOME_DIR, opts.credentialPaths ?? [])}`;
        const prep = await execRaw(name, `mkdir -p ${shq(workspaceDir)}${credLinks}`, 60);
        if (prep.code !== 0)
          throw new Error(`sprites provision prep failed: ${(prep.stderr || prep.stdout).slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "sprites" },
        );

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs("sprites-sandbox: teardown after failed provision", undefined));
        throw err;
      }
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      const signal = execOpts?.signal;
      if (!signal) return execRaw(handle.id, script, timeoutSec);
      const killUid = randomUUID();
      const fireKill = () => {
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("sprites-sandbox: kill in-flight exec", undefined));
      };
      if (signal.aborted) fireKill();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await execRaw(handle.id, killableScript(script, killUid), timeoutSec);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), data);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    backupComputer: execBackup.backupComputer,

    async computerStatus(scopeId: string) {
      const name = spriteScopeName(prefix, scopeId);
      let machine: string;
      try {
        const res = await fetchImpl(`${baseUrl}/v1/sprites/${encodeURIComponent(name)}/check`, {
          headers: { authorization: `Bearer ${opts.token ?? ""}` },
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        const body = res.ok ? ((await res.json().catch(() => null)) as { status?: string } | null) : null;
        machine = body?.status ?? `check failed: http ${res.status}`;
      } catch (e) {
        machine = `check failed: ${errMessage(e)}`;
      }
      let guestResponsive = false;
      try {
        guestResponsive = (await execRaw(name, "true", GUEST_PROBE_TIMEOUT_SEC)).code === 0;
      } catch (e) {
        void e;
      }
      return { machine, guestResponsive };
    },

    async restartComputer(scopeId: string): Promise<void> {
      const name = spriteScopeName(prefix, scopeId);
      ensured.delete(name);
      const res = await fetchImpl(`${baseUrl}/v1/sprites/${encodeURIComponent(name)}/restart`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token ?? ""}` },
        signal: AbortSignal.timeout(RESTART_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`sprites restart ${name}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
    },

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      if (handle.scratch) {
        const key = scratchKeyByName.get(handle.id);
        return provisionQueue(key ? `scratch:${key}` : handle.id, async () => {
          const remaining = (activeScratch.get(handle.id) ?? 1) - 1;
          if (remaining > 0) {
            activeScratch.set(handle.id, remaining);
            return;
          }
          activeScratch.delete(handle.id);
          ensured.delete(handle.id);
          if (tdOpts?.destroy) await client.deleteSprite(handle.id);
          else await client.deleteSprite(handle.id).catch(swallowAs("sprites-sandbox: scratch delete", undefined));
        });
      }
      if (!tdOpts?.destroy) return;
      ensured.delete(handle.id);
      await client.deleteSprite(handle.id).catch((e) => {
        const scope = scopeByName.get(handle.id);
        opts.onError?.({
          category: "sandbox_teardown",
          code: "sprite_delete_failed",
          message: errMessage(e),
          ...(scope ? { scopeLabel: scope } : {}),
        });
      });
    },
  };

  return sandbox;
}
