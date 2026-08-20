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
export const DIRECT_HELPER_EXECUTABLE = "/usr/local/bin/node";
export const DIRECT_HELPER_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const dynamicKeys = new Set(["AGENT_API_URL", "AGENT_API_TOKEN", "AGENT_OAUTH_CONSENT_TOKEN", "AGENT_CREDENTIAL_TOKEN", "AGENT_OUTBOX"]);
const runtimePath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const inputCap = 16 * 1024 * 1024;
const outputCap = 64 * 1024 * 1024;
const requestCap = 128 * 1024 * 1024;
const resultCap = 256 * 1024 * 1024;
const dynamicKey = (key) => dynamicKeys.has(key);
const canonical = (value) => typeof value === "string" && value.startsWith("/") && value !== "/" && !value.endsWith("/") && !value.includes("\\") && !value.includes("\0") && value.split("/").slice(1).every((part) => part.length > 0 && part !== "." && part !== "..");
const bounded = (value, fallback, cap) => {
  const result = value === undefined ? fallback : Number(value);
  return Number.isSafeInteger(result) && result >= 0 && result <= cap ? result : null;
};
const output = (value) => {
  const encoded = JSON.stringify(value);
  process.stdout.write(encoded.length > resultCap ? JSON.stringify({ error: "direct helper result exceeds limit" }) : encoded);
};
const run = (raw) => {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return output({ error: "invalid direct request" });
  }
  if (!request || !Array.isArray(request.argv) || request.argv.length === 0 || request.argv.length > 4096 || request.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !canonical(request.argv[0])) return output({ error: "invalid direct argv" });
  if (!canonical(request.rootDir) || !canonical(request.cwd)) return output({ error: "invalid direct path" });
  const root = path.posix.normalize(request.rootDir);
  const cwd = path.posix.normalize(request.cwd);
  const relative = path.posix.relative(root, cwd);
  if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative) || request.cwd.split("/").includes("..")) return output({ error: "direct cwd escapes rootDir" });
  const dynamicEnvKeys = request.dynamicEnvKeys === undefined ? [] : request.dynamicEnvKeys;
  if (!Array.isArray(dynamicEnvKeys) || dynamicEnvKeys.some((key) => typeof key !== "string" || !dynamicKey(key)) || new Set(dynamicEnvKeys).size !== dynamicEnvKeys.length) return output({ error: "invalid dynamic env keys" });
  const allowedEnvKeys = request.allowedEnvKeys === undefined ? [] : request.allowedEnvKeys;
  if (!Array.isArray(allowedEnvKeys) || allowedEnvKeys.some((key) => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key === "PATH" || key.startsWith("AGENT_")) || new Set(allowedEnvKeys).size !== allowedEnvKeys.length) return output({ error: "invalid allowed env keys" });
  if (!request.env || typeof request.env !== "object" || Array.isArray(request.env)) return output({ error: "invalid direct env" });
  for (const [key, value] of Object.entries(request.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || (key === "PATH" && value !== runtimePath) || (key !== "PATH" && !dynamicEnvKeys.includes(key) && !allowedEnvKeys.includes(key)) || (key.startsWith("AGENT_") && !dynamicEnvKeys.includes(key)) || typeof value !== "string" || value.includes("\0")) return output({ error: "invalid direct env" });
  }
  const timeoutMs = bounded(request.timeoutMs, 600000, 86400000);
  const stdoutMaxBytes = bounded(request.stdoutMaxBytes, 4 * 1024 * 1024, outputCap);
  const stderrMaxBytes = bounded(request.stderrMaxBytes, 4 * 1024 * 1024, outputCap);
  if (timeoutMs === null || stdoutMaxBytes === null || stderrMaxBytes === null) return output({ error: "invalid direct limits" });
  let stdin = Buffer.alloc(0);
  if (request.stdinB64 !== undefined) {
    if (typeof request.stdinB64 !== "string") return output({ error: "invalid direct stdin" });
    stdin = Buffer.from(request.stdinB64, "base64");
    if (stdin.length > inputCap) return output({ error: "direct stdin exceeds limit" });
  }
  let rootReal;
  let cwdReal;
  let executableReal;
  try {
    rootReal = fs.realpathSync(root);
    cwdReal = fs.realpathSync(cwd);
    executableReal = fs.realpathSync(request.argv[0]);
    if (cwdReal !== rootReal && !cwdReal.startsWith(rootReal + path.sep)) return output({ error: "direct cwd escapes rootDir" });
    if (executableReal !== request.argv[0] || !fs.statSync(executableReal).isFile()) return output({ error: "direct executable is not canonical" });
  } catch {
    return output({ error: "direct path is not available" });
  }
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  let finished = false;
  const child = childProcess.spawn(request.argv[0], request.argv.slice(1), { cwd: cwdReal, env: { ...request.env }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const killTree = () => {
    if (finished || !child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => {
    if (!finished) {
      timedOut = true;
      killTree();
    }
  }, Math.max(1, timeoutMs));
  const take = (parts, current, chunk, limit, stream) => {
    const remaining = Math.max(0, limit - current);
    if (remaining) parts.push(chunk.subarray(0, remaining));
    const next = current + chunk.length;
    if (next > limit) {
      outputLimitExceeded = true;
      stream.destroy();
      killTree();
    }
    return next;
  };
  child.stdout.on("data", (chunk) => { stdoutBytes = take(stdout, stdoutBytes, chunk, stdoutMaxBytes, child.stdout); });
  child.stderr.on("data", (chunk) => { stderrBytes = take(stderr, stderrBytes, chunk, stderrMaxBytes, child.stderr); });
  child.stdin.end(stdin);
  child.on("error", (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    output({ error: "direct helper could not start executable" });
  });
  child.on("close", (code, signal) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const resultCode = timedOut ? 124 : outputLimitExceeded ? 122 : code === null ? 1 : code;
    output({ stdoutB64: Buffer.concat(stdout).toString("base64"), stderrB64: Buffer.concat(stderr).toString("base64"), code: resultCode, timedOut, outputLimitExceeded, stdoutTruncated: stdoutBytes > stdoutMaxBytes, stderrTruncated: stderrBytes > stderrMaxBytes, signal: signal || undefined });
  });
};
const chunks = [];
let size = 0;
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > requestCap) process.exit(400);
  chunks.push(chunk);
});
process.stdin.on("end", () => run(Buffer.concat(chunks).toString("utf8")));
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
    for (const arg of [DIRECT_HELPER_EXECUTABLE, "-e", DIRECT_HELPER_SCRIPT]) url.searchParams.append("cmd", arg);
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
