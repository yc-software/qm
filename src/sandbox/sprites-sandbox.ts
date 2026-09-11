import { randomUUID } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
import { SpritesClient } from "@fly/sprites";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { sleep } from "../util/async.ts";
import { swallow, swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import {
  createBackendBlobStaging,
  createExecExport,
  createExecFileOps,
  type BlobStagingOptions,
} from "./exec-file-ops.ts";
import type { CredentialPathSpec } from "../credentials/resident-paths.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import { visibleNotInstalled, visibleTools } from "./sandbox.ts";
import { createExecSandboxBase, sandboxScopeName } from "./exec-sandbox-base.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import type { AgentComputerProfile, ExecPressure, ExecResult, Sandbox } from "./sandbox.ts";

const HOME_DIR = "/home/sprite";
const spritesDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, allowH2: false });
export const SCRIPT_RUNNER = 's=$(mktemp) && cat > "$s" && sh "$s" </dev/null; rc=$?; rm -f "$s"; exit $rc';
export const FETCH_SUBSTRATE = Symbol.for("qm.fetchSubstrate");
const defaultSpritesFetch: typeof fetch = (input, init) => {
  const g = globalThis.fetch as typeof fetch & { [FETCH_SUBSTRATE]?: boolean };
  return g[FETCH_SUBSTRATE] ? g(input, init) : (undiciFetch as unknown as typeof fetch)(input, init);
};
const MISSING_RC = 44;
const READ_CHUNK = 512 * 1024;
const EXIT_GRACE_MS = 60_000;
const RESTART_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 30_000;
const GUEST_PROBE_TIMEOUT_SEC = 15;
const DEFAULT_SPRITES_BASE_URL = "https://api.sprites.dev";
const PRESSURE_RECORD_FULL60 = 75;
const PRESSURE_CLEAR_FULL60 = 40;
const FORCED_RESTART_ATTEMPTS = 3;
const FORCED_RESTART_RETRY_MS = 5_000;

function parsePressure(ioFull10Raw: string, ioFull60Raw: string, load1Raw: string): ExecPressure | undefined {
  const ioFull10 = Number.parseFloat(ioFull10Raw);
  const ioFull60 = Number.parseFloat(ioFull60Raw);
  const load1 = Number.parseFloat(load1Raw);
  if (!Number.isFinite(ioFull60) || ioFull60 < 0) return undefined;
  return {
    ioFull10: Number.isFinite(ioFull10) && ioFull10 >= 0 ? ioFull10 : ioFull60,
    ioFull60,
    load1: Number.isFinite(load1) && load1 >= 0 ? load1 : 0,
  };
}

export interface SpritesClientLike {
  getSprite(name: string): Promise<unknown>;
  createSprite(name: string): Promise<unknown>;
  deleteSprite(name: string): Promise<void>;
}

export interface SpritesSandboxOptions extends BlobStagingOptions {
  token?: string;
  baseUrl?: string;
  namePrefix?: string;
  defaultTimeoutSec?: number;
  egressProxyUrl?: string;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  client?: SpritesClientLike;
  fetchImpl?: typeof fetch;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createSpritesSandbox(workspace: WorkspaceStore, opts: SpritesSandboxOptions = {}): Sandbox {
  if ((!opts.client || !opts.fetchImpl) && !opts.token)
    throw new Error("SANDBOX_BACKEND=sprites requires SPRITES_TOKEN");
  const client: SpritesClientLike =
    opts.client ?? (new SpritesClient(opts.token!, opts.baseUrl ? { baseURL: opts.baseUrl } : {}) as SpritesClientLike);
  const rawFetch = opts.fetchImpl ?? defaultSpritesFetch;
  const fetchImpl: typeof fetch = (input, init) =>
    rawFetch(input, { dispatcher: spritesDispatcher, ...init } as RequestInit);
  const baseUrl = (opts.baseUrl ?? DEFAULT_SPRITES_BASE_URL).replace(/\/+$/, "");
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;

  const ensured = new Set<string>();

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
    } as RequestInit);
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
    const psi = `$(awk -F'[= ]+' '/^full/{print $3, $5; f=1} END{if(!f)print "-1 -1"}' /proc/pressure/io 2>/dev/null || echo '-1 -1')`;
    const load = `$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo -1)`;
    const body = `/tmp/.exec-${uid}.sh`;
    const eof = `__QM_EOF_${uid}__`;
    const wrapped =
      `cat > ${body} <<'${eof}'\n${script}\n${eof}\n` +
      `timeout ${timeoutSec} sh ${body} > ${out} 2> ${err}; __rc=$?; printf '%s %s %s %s %s\\n' "$__rc" "$(wc -c < ${out})" "$(wc -c < ${err})" "${psi}" "${load}"; base64 < ${out}; base64 < ${err}; rm -f ${out} ${err} ${body}`;
    const r = await postExec(name, ["sh", "-c", SCRIPT_RUNNER], timeoutSec, Buffer.from(wrapped, "utf8"));
    const text = r.stdout.toString("utf8");
    const nl = text.indexOf("\n");
    const header = text
      .slice(0, nl < 0 ? undefined : nl)
      .trim()
      .split(/\s+/);
    if (r.rc !== 0 || nl < 0 || header.length < 3) {
      throw new Error(`sprites exec ${name}: bad envelope (rc=${r.rc}): ${text.slice(0, 120)}`);
    }
    const pressure = header.length === 6 ? parsePressure(header[3]!, header[4]!, header[5]!) : undefined;
    if (pressure) notePressure(name, pressure);
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
    return {
      stdout: outBuf.toString("utf8"),
      stderr: errBuf.toString("utf8"),
      code,
      timedOut: code === 124,
      ...(pressure ? { pressure } : {}),
    };
  }

  const pressureEpisodes = new Set<string>();
  function notePressure(name: string, pressure: ExecPressure): void {
    if (pressure.ioFull60 >= PRESSURE_RECORD_FULL60 && !pressureEpisodes.has(name)) {
      pressureEpisodes.add(name);
      const scope = base.scopeFor(name);
      try {
        opts.onError?.({
          category: "agent_computer",
          code: "io_pressure_high",
          message: `sprite ${name}: io pressure full avg60=${pressure.ioFull60}% (load ${pressure.load1}) — disk-bound work is stalling`,
          ...(scope ? { scopeLabel: scope } : {}),
        });
      } catch (e) {
        swallow("sprites-sandbox: io pressure report", e);
      }
    } else if (pressure.ioFull60 < PRESSURE_CLEAR_FULL60) {
      pressureEpisodes.delete(name);
    }
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

  const base = createExecSandboxBase({
    workspace,
    label: "sprites",
    prefix,
    homeDir: HOME_DIR,
    defaultTimeoutSec,
    credentialPaths: opts.credentialPaths ?? [],
    ...(opts.layerToolFiles ? { installLayerTools: createLayerToolInstaller(opts.layerToolFiles) } : {}),
    egressProxyUrl: opts.egressProxyUrl,
    deleteFailureCode: "sprite_delete_failed",
    onError: opts.onError,
    exec: execRaw,
    writeAbsBytes,
    readAbsBytes,
    async ensureResident(name, onStatus) {
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
    },
    isProvisioned: (name) => ensured.has(name),
    async recreateScratch(name) {
      let stale = true;
      try {
        await client.getSprite(name);
      } catch {
        stale = false;
      }
      if (stale) await client.deleteSprite(name).catch(swallowAs("sprites-sandbox: stale scratch delete", undefined));
      await client.createSprite(name);
      ensured.add(name);
    },
    deleteInstance: (name) => client.deleteSprite(name),
    forgetInstance: (name) => {
      ensured.delete(name);
      pressureEpisodes.delete(name);
      egressPolicyByName.delete(name);
    },
    ensureEgress: ensureEgressPolicy,
  });

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
      workdir: base.workspaceDir,
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

  const blobStaging = createBackendBlobStaging("sprites", (id, script, t) => execRaw(id, script, t), opts);

  const execExport = createExecExport({
    label: "sprites",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: HOME_DIR,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  return {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,
    ...blobStaging,
    provision: base.provision,
    run: base.run,
    writeFileBytes: base.writeFileBytes,
    writeFile: base.writeFile,
    readFileBytes: base.readFileBytes,
    readFile: base.readFile,
    exportFiles: execExport.exportFiles,

    async destroyScope(scopeId: string): Promise<void> {
      return base.provisionQueue(scopeId, async () => {
        const name = sandboxScopeName(prefix, scopeId);
        const res = await fetchImpl(`${baseUrl}/v1/sprites/${encodeURIComponent(name)}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${opts.token ?? ""}` },
          signal: AbortSignal.timeout(RESTART_TIMEOUT_MS),
        });
        if (!res.ok && res.status !== 404)
          throw new Error(`sprites delete ${name}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
        ensured.delete(name);
        pressureEpisodes.delete(name);
        egressPolicyByName.delete(name);
      });
    },

    async computerStatus(scopeId: string) {
      const name = sandboxScopeName(prefix, scopeId);
      const spriteJson = async (path: string): Promise<{ status?: string } | null> => {
        const res = await fetchImpl(`${baseUrl}/v1/sprites/${encodeURIComponent(name)}${path}`, {
          headers: { authorization: `Bearer ${opts.token ?? ""}` },
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`http ${res.status}`);
        return (await res.json().catch(() => null)) as { status?: string } | null;
      };
      const [machineOut, listedOut] = await Promise.allSettled([spriteJson("/check"), spriteJson("")]);
      const machine =
        machineOut.status === "fulfilled"
          ? (machineOut.value?.status ?? "check failed: no status")
          : `check failed: ${errMessage(machineOut.reason)}`;
      const listed = listedOut.status === "fulfilled" ? listedOut.value?.status : undefined;
      let guestResponsive = false;
      let pressure: ExecPressure | undefined;
      try {
        const probe = await execRaw(name, "true", GUEST_PROBE_TIMEOUT_SEC);
        guestResponsive = probe.code === 0;
        pressure = probe.pressure;
      } catch (e) {
        void e;
      }
      return {
        machine,
        ...(listed ? { listed } : {}),
        provisioned: machineOut.status === "fulfilled",
        guestResponsive,
        ...(pressure ? { pressure } : {}),
      };
    },

    restartComputer(scopeId: string): Promise<void> {
      const name = sandboxScopeName(prefix, scopeId);
      return base.provisionQueue(`restart:${name}`, async () => {
        ensured.delete(name);
        egressPolicyByName.delete(name);
        const restart = (force: boolean) =>
          fetchImpl(`${baseUrl}/v1/sprites/${encodeURIComponent(name)}/restart${force ? "?force=true" : ""}`, {
            method: "POST",
            headers: { authorization: `Bearer ${opts.token ?? ""}` },
            signal: AbortSignal.timeout(RESTART_TIMEOUT_MS),
          });
        const plain = await restart(false);
        if (plain.ok) return;
        const plainDetail = `http ${plain.status} ${(await plain.text()).slice(0, 200)}`;
        if (plain.status !== 409 && plain.status !== 502) throw new Error(`sprites restart ${name}: ${plainDetail}`);
        let forcedDetail = "";
        for (let attempt = 0; attempt < FORCED_RESTART_ATTEMPTS; attempt++) {
          if (attempt > 0) await sleep(FORCED_RESTART_RETRY_MS);
          const forced = await restart(true);
          if (forced.ok) return;
          forcedDetail = `http ${forced.status} ${(await forced.text()).slice(0, 200)}`;
          if (forced.status !== 409 && forced.status !== 502) break;
        }
        throw new Error(`sprites restart ${name}: ${plainDetail}; forced retry: ${forcedDetail}`);
      });
    },

    teardown: base.teardown,
  };
}
