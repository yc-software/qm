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
import { CapabilityUnsupportedError } from "./sandbox.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";
import { directRequest, type DirectExecOptions, type ScopedCommand } from "./scoped-exec.ts";

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
const DIRECT_HELPER_RESPONSE_MAX_BYTES = 256 * 1024 * 1024;
export const DIRECT_HELPER_EXECUTABLE = "/usr/bin/python3";
export const DIRECT_HELPER_SCRIPT = String.raw`
import base64
import ctypes
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

dynamic_keys = {"AGENT_API_URL", "AGENT_API_TOKEN", "AGENT_OAUTH_CONSENT_TOKEN", "AGENT_CREDENTIAL_TOKEN", "AGENT_OUTBOX"}
runtime_path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
input_cap = 16 * 1024 * 1024
output_cap = 64 * 1024 * 1024
request_cap = 128 * 1024 * 1024
result_cap = 256 * 1024 * 1024
env_name = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
helper_pid = os.getpid()

def output(value):
    encoded = json.dumps(value, separators=(",", ":"))
    if len(encoded.encode()) > result_cap:
        encoded = json.dumps({"error": "direct helper result exceeds limit"}, separators=(",", ":"))
    sys.stdout.write(encoded)

def canonical(value):
    return isinstance(value, str) and value.startswith("/") and value != "/" and not value.endswith("/") and "\\" not in value and "\0" not in value and all(part not in ("", ".", "..") for part in value.split("/")[1:])

def bounded(value, fallback, cap):
    result = fallback if value is None else value
    return result if isinstance(result, int) and not isinstance(result, bool) and 0 <= result <= cap else None

def fail(message):
    output({"error": message})
    raise SystemExit(0)

def enable_subreaper():
    if sys.platform != "linux":
        return
    try:
        with open("/proc/self/stat", "rb") as stat_file:
            stat_file.read(1)
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            fail("direct helper containment unavailable")
    except SystemExit:
        raise
    except Exception:
        fail("direct helper containment unavailable")

def descendants():
    if sys.platform != "linux":
        return set()
    parents = {}
    try:
        entries = os.scandir("/proc")
    except Exception:
        return set()
    with entries:
        for entry in entries:
            if not entry.name.isdigit():
                continue
            try:
                with open(f"/proc/{entry.name}/stat", "r", encoding="utf-8") as stat_file:
                    stat = stat_file.read()
                fields = stat[stat.rfind(")") + 2:].split()
                parents[int(entry.name)] = int(fields[1])
            except Exception:
                continue
    result = set()
    changed = True
    while changed:
        changed = False
        for pid, parent in parents.items():
            if pid != helper_pid and pid not in result and (parent == helper_pid or parent in result):
                result.add(pid)
                changed = True
    return result

raw = sys.stdin.buffer.read(request_cap + 1)
if len(raw) > request_cap:
    raise SystemExit(400)
try:
    request = json.loads(raw)
except Exception:
    fail("invalid direct request")

argv = request.get("argv") if isinstance(request, dict) else None
if not isinstance(argv, list) or not argv or len(argv) > 4096 or any(not isinstance(arg, str) or "\0" in arg for arg in argv) or not canonical(argv[0]):
    fail("invalid direct argv")
root_dir = request.get("rootDir")
cwd = request.get("cwd")
if not canonical(root_dir) or not canonical(cwd):
    fail("invalid direct path")
root = os.path.normpath(root_dir)
workdir = os.path.normpath(cwd)
relative = os.path.relpath(workdir, root)
if relative == ".." or relative.startswith("../") or os.path.isabs(relative) or ".." in cwd.split("/"):
    fail("direct cwd escapes rootDir")
dynamic_env_keys = request.get("dynamicEnvKeys", [])
if not isinstance(dynamic_env_keys, list) or any(not isinstance(key, str) or key not in dynamic_keys for key in dynamic_env_keys) or len(set(dynamic_env_keys)) != len(dynamic_env_keys):
    fail("invalid dynamic env keys")
allowed_env_keys = request.get("allowedEnvKeys", [])
if not isinstance(allowed_env_keys, list) or any(not isinstance(key, str) or not env_name.fullmatch(key) or key == "PATH" or key.startswith("AGENT_") for key in allowed_env_keys) or len(set(allowed_env_keys)) != len(allowed_env_keys):
    fail("invalid allowed env keys")
env = request.get("env")
if not isinstance(env, dict):
    fail("invalid direct env")
for key, value in env.items():
    if not isinstance(key, str) or not env_name.fullmatch(key) or (key == "PATH" and value != runtime_path) or (key != "PATH" and key not in dynamic_env_keys and key not in allowed_env_keys) or (key.startswith("AGENT_") and key not in dynamic_env_keys) or not isinstance(value, str) or "\0" in value:
        fail("invalid direct env")
timeout_ms = bounded(request.get("timeoutMs"), 600000, 86400000)
stdout_max = bounded(request.get("stdoutMaxBytes"), 4 * 1024 * 1024, output_cap)
stderr_max = bounded(request.get("stderrMaxBytes"), 4 * 1024 * 1024, output_cap)
if timeout_ms is None or stdout_max is None or stderr_max is None:
    fail("invalid direct limits")
try:
    stdin = base64.b64decode(request.get("stdinB64", ""), validate=True)
except Exception:
    fail("invalid direct stdin")
if len(stdin) > input_cap:
    fail("direct stdin exceeds limit")
try:
    root_real = os.path.realpath(root)
    cwd_real = os.path.realpath(workdir)
    executable_real = os.path.realpath(argv[0])
    if cwd_real != root_real and not cwd_real.startswith(root_real + os.sep):
        fail("direct cwd escapes rootDir")
    if executable_real != argv[0] or not os.path.isfile(executable_real):
        fail("direct executable is not canonical")
except SystemExit:
    raise
except Exception:
    fail("direct path is not available")
enable_subreaper()
try:
    child = subprocess.Popen(argv, cwd=cwd_real, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
except Exception:
    fail("direct helper could not start executable")

stdout_parts = []
stderr_parts = []
totals = {"stdout": 0, "stderr": 0}
limit_exceeded = threading.Event()
stdout_done = threading.Event()
stderr_done = threading.Event()

def kill_tree():
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except Exception:
        try:
            child.kill()
        except Exception:
            pass
    if sys.platform == "linux":
        for _ in range(32):
            found = descendants()
            if not found:
                break
            for pid in found:
                try:
                    os.kill(pid, signal.SIGKILL)
                except Exception:
                    pass
            for pid in found:
                if pid == child.pid:
                    continue
                try:
                    os.waitpid(pid, os.WNOHANG)
                except Exception:
                    pass
            time.sleep(0.005)

def read_stream(name, stream, parts, limit, done):
    try:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                return
            remaining = max(0, limit - totals[name])
            if remaining:
                parts.append(chunk[:remaining])
            totals[name] += len(chunk)
            if totals[name] > limit:
                limit_exceeded.set()
                kill_tree()
    finally:
        done.set()

def write_stdin():
    try:
        child.stdin.write(stdin)
        child.stdin.close()
    except Exception:
        pass

threads = [
    threading.Thread(target=read_stream, args=("stdout", child.stdout, stdout_parts, stdout_max, stdout_done), daemon=True),
    threading.Thread(target=read_stream, args=("stderr", child.stderr, stderr_parts, stderr_max, stderr_done), daemon=True),
    threading.Thread(target=write_stdin, daemon=True),
]
for thread in threads:
    thread.start()
deadline = time.monotonic() + max(1, timeout_ms) / 1000
timed_out = False
while True:
    if limit_exceeded.is_set():
        kill_tree()
        break
    if time.monotonic() >= deadline:
        timed_out = True
        kill_tree()
        break
    if child.poll() is not None and stdout_done.is_set() and stderr_done.is_set():
        kill_tree()
        break
    time.sleep(0.005)
child.wait()
for thread in threads:
    thread.join(timeout=1)
return_code = 124 if timed_out else 122 if limit_exceeded.is_set() else child.returncode if child.returncode >= 0 else 1
signal_name = None
if child.returncode < 0:
    try:
        signal_name = signal.Signals(-child.returncode).name
    except Exception:
        signal_name = None
result = {
    "stdoutB64": base64.b64encode(b"".join(stdout_parts)).decode("ascii"),
    "stderrB64": base64.b64encode(b"".join(stderr_parts)).decode("ascii"),
    "code": return_code,
    "timedOut": timed_out,
    "outputLimitExceeded": limit_exceeded.is_set(),
    "stdoutTruncated": totals["stdout"] > stdout_max,
    "stderrTruncated": totals["stderr"] > stderr_max,
}
if signal_name:
    result["signal"] = signal_name
output(result)
`;

export interface SpritesClientLike {
  getSprite(name: string): Promise<unknown>;
  createSprite(name: string): Promise<unknown>;
  deleteSprite(name: string): Promise<void>;
  sprite?(name: string): unknown;
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
  const nativeDirect = Boolean(opts.token && typeof fetchImpl === "function");
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

  async function execDirectNative(
    name: string,
    request: {
      argv: string[];
      cwd: string;
      rootDir: string;
      env: Record<string, string>;
      allowedEnvKeys: string[];
      dynamicEnvKeys: string[];
      stdin?: Uint8Array;
      timeoutMs: number;
      stdoutMaxBytes: number;
      stderrMaxBytes: number;
    },
    signal?: AbortSignal,
  ): Promise<
    RawExec & {
      timedOut: boolean;
      outputLimitExceeded: boolean;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      signal?: string;
    }
  > {
    const url = new URL(`${baseUrl}/v1/sprites/${encodeURIComponent(name)}/exec`);
    for (const arg of [DIRECT_HELPER_EXECUTABLE, "-c", DIRECT_HELPER_SCRIPT]) url.searchParams.append("cmd", arg);
    url.searchParams.set("path", DIRECT_HELPER_EXECUTABLE);
    url.searchParams.set("stdin", "true");
    url.searchParams.set("max_run_after_disconnect", "0s");
    const payload = Buffer.from(
      JSON.stringify({
        argv: request.argv,
        rootDir: request.rootDir,
        cwd: request.cwd,
        env: request.env,
        allowedEnvKeys: request.allowedEnvKeys,
        dynamicEnvKeys: request.dynamicEnvKeys,
        ...(request.stdin ? { stdinB64: Buffer.from(request.stdin).toString("base64") } : {}),
        timeoutMs: request.timeoutMs,
        stdoutMaxBytes: request.stdoutMaxBytes,
        stderrMaxBytes: request.stderrMaxBytes,
      }),
    );
    const timeoutSignal = AbortSignal.timeout(request.timeoutMs + EXIT_GRACE_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token ?? ""}`, "content-type": "application/octet-stream" },
        body: payload,
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (timeoutSignal.aborted) {
        return {
          rc: 124,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          timedOut: true,
          outputLimitExceeded: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      throw new Error("sprites direct execution request failed", { cause: error });
    }
    if (!response.ok || !response.body) throw new Error("sprites direct execution request failed");
    const timeoutResult = (): RawExec & {
      timedOut: boolean;
      outputLimitExceeded: boolean;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      signal?: string;
    } => ({
      rc: 124,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: true,
      outputLimitExceeded: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const responseChunks: Buffer[] = [];
    let responseBytes = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        responseBytes += value.length;
        if (responseBytes > DIRECT_HELPER_RESPONSE_MAX_BYTES)
          throw new Error("sprites direct execution response exceeded limit");
        responseChunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (timeoutSignal.aborted) return timeoutResult();
      throw new Error("sprites direct execution response failed", { cause: error });
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const responseBytesAll = Buffer.concat(responseChunks);
    const stdout: Buffer[] = [];
    let exitCode = -1;
    let offset = 0;
    while (offset < responseBytesAll.length) {
      const frameType = responseBytesAll[offset++]!;
      if (frameType === 3) {
        if (offset >= responseBytesAll.length)
          throw new Error("sprites direct execution returned an invalid exit frame");
        exitCode = responseBytesAll[offset++]!;
        continue;
      }
      if (frameType !== 1 && frameType !== 2) throw new Error("sprites direct execution returned an unsupported frame");
      const start = offset;
      while (offset < responseBytesAll.length && responseBytesAll[offset]! >= 4) offset++;
      const frame = responseBytesAll.subarray(start, offset);
      if (frameType === 1) stdout.push(frame);
    }
    if (exitCode < 0) throw new Error("sprites direct execution returned no exit frame");
    let envelope: {
      stdoutB64?: string;
      stderrB64?: string;
      code?: number;
      timedOut?: boolean;
      outputLimitExceeded?: boolean;
      stdoutTruncated?: boolean;
      stderrTruncated?: boolean;
      signal?: string;
      error?: string;
    };
    try {
      envelope = JSON.parse(Buffer.concat(stdout).toString("utf8")) as typeof envelope;
    } catch {
      throw new Error("sprites direct helper returned an invalid result");
    }
    if (envelope.error) throw new Error(`sprites direct helper failed: ${envelope.error}`);
    if (
      typeof envelope.code !== "number" ||
      typeof envelope.stdoutB64 !== "string" ||
      typeof envelope.stderrB64 !== "string"
    ) {
      throw new Error("sprites direct helper returned an invalid result");
    }
    return {
      rc: envelope.code,
      stdout: Buffer.from(envelope.stdoutB64, "base64"),
      stderr: Buffer.from(envelope.stderrB64, "base64"),
      timedOut: !!envelope.timedOut,
      outputLimitExceeded: !!envelope.outputLimitExceeded,
      stdoutTruncated: !!envelope.stdoutTruncated,
      stderrTruncated: !!envelope.stderrTruncated,
      ...(envelope.signal ? { signal: envelope.signal } : {}),
    };
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
    directExecution: nativeDirect,
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
        const prep = await execRaw(
          name,
          `${shq(DIRECT_HELPER_EXECUTABLE)} -c ${shq("")} && mkdir -p ${shq(workspaceDir)}${credLinks}`,
          60,
        );
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

    async runDirect(handle: SandboxHandle, command: ScopedCommand, execOpts?: DirectExecOptions): Promise<ExecResult> {
      if (!nativeDirect) throw new CapabilityUnsupportedError(profile.backend, "structured direct execution");
      const request = directRequest(handle.rootDir, command, execOpts);
      execOpts?.signal?.throwIfAborted();
      const result = await execDirectNative(handle.id, request, execOpts?.signal);
      return {
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
        code: result.rc,
        timedOut: result.timedOut,
        ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
        ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
        ...(result.outputLimitExceeded ? { outputLimitExceeded: true } : {}),
        ...(result.signal ? { signal: result.signal } : {}),
      };
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
