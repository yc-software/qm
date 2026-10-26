import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { Readable } from "node:stream";
import { APIError, SpritesClient, type Checkpoint, type SpriteCheck, type StreamMessage } from "@fly/sprites";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { jitteredBackoffMs, retryAfterMs, withAbort, withTimeout } from "../util/async.ts";
import { swallow, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { processSessionDir } from "./exec-process-session.ts";
import { createProviderSandbox, type SandboxShared, type StoredSandboxRecord } from "./provider-sandbox.ts";
import type { ExecPressure, ExecResult, Sandbox } from "./sandbox.ts";

const HOME_DIR = "/home/sprite";
export const SCRIPT_RUNNER = 's=$(mktemp) && cat > "$s" && sh "$s" </dev/null; rc=$?; rm -f "$s"; exit $rc';
const EXIT_GRACE_MS = 60_000;
const KEEPALIVE_TIMEOUT_SEC = 20;
const CHECKPOINT_COMMENT = "qm turn end";
const KEEPALIVE_EXPIRE = "5m";
const KEEPALIVE_RENEW_SEC = 60;
const SPRITE_CPUS = 8;
const SPRITE_DISK_GB = 100;
const PRESSURE_RECORD_FULL60 = 75;
const PRESSURE_CLEAR_FULL60 = 40;

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

function withoutSdkUrl(message: string): string {
  const url = message.lastIndexOf(" (url: ");
  return url < 0 ? message : message.slice(0, url);
}

export function spritesErrorDetail(e: unknown): string {
  if (!(e instanceof APIError)) return errMessage(e);
  const parts = [e.message];
  if (e.statusCode !== undefined) parts.push(`http ${e.statusCode}`);
  if (e.errorCode && e.errorCode !== e.message) parts.push(e.errorCode);
  const retryAfter = e.getRetryAfterSeconds();
  if (retryAfter !== undefined && !e.message.includes("retry after")) parts.push(`retry after ${retryAfter}s`);
  return parts.join("; ");
}

export async function retrySpritesControl<T>(operation: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  for (let attempt = 1; ; attempt++) {
    try {
      return await withAbort(operation, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof APIError) || ![429, 500, 502, 503, 504].includes(error.statusCode ?? 0) || attempt >= 4)
        throw error;
      const seconds = error.getRetryAfterSeconds();
      const delay = seconds === undefined ? undefined : retryAfterMs(new Headers({ "retry-after": String(seconds) }));
      try {
        await wait(delay ?? jitteredBackoffMs(attempt), undefined, { signal });
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
    }
  }
}

const isMissing = (e: unknown): boolean => e instanceof APIError && e.statusCode === 404;

const describeCheck = (check: SpriteCheck): string => `${check.status}${check.reason ? ` (${check.reason})` : ""}`;

export function processKeepaliveScript(processId: string): string {
  const task = `qm-proc-${processId}`;
  const api = "curl -sf --unix-socket /.sprite/api.sock -H 'Content-Type: application/json'";
  const loop = [
    `P="${processSessionDir(processId)}"`,
    `while [ ! -f "$P/code" ] && kill -0 "$(cat "$P/pid" 2>/dev/null)" 2>/dev/null; do`,
    `  ${api} -X PUT -d '{"expire":"${KEEPALIVE_EXPIRE}"}' http://sprite/v1/tasks/${task} >/dev/null 2>&1 || true`,
    `  i=0; while [ $i -lt ${KEEPALIVE_RENEW_SEC} ] && [ ! -f "$P/code" ]; do sleep 1; i=$((i+1)); done`,
    `done`,
    `${api} -X DELETE http://sprite/v1/tasks/${task} >/dev/null 2>&1 || true`,
  ].join("\n");
  return `LOOP=${shq(loop)}; if command -v setsid >/dev/null 2>&1; then setsid sh -c "$LOOP" >/dev/null 2>&1 & else sh -c "$LOOP" >/dev/null 2>&1 & fi; echo OK`;
}

export type StoredSpritesSandbox = StoredSandboxRecord;

export interface SpritesSandboxOptions extends SandboxShared {
  token?: string;
  baseUrl?: string;
  store: DurableMap<StoredSpritesSandbox>;
}

interface RawExec {
  rc: number;
  stdout: Buffer;
  stderr: Buffer;
}

export function createSpritesSandbox(workspace: WorkspaceStore, opts: SpritesSandboxOptions): Sandbox {
  if (!opts.token) throw new Error("SANDBOX_BACKEND=sprites requires SPRITES_TOKEN");
  const client = new SpritesClient(opts.token, opts.baseUrl ? { baseURL: opts.baseUrl } : {});
  const sprite = (name: string) => client.sprite(name);

  const live = new Set<string>();
  const resourcesApplied = new Set<string>();
  const egressPolicyByName = new Map<string, string>();
  const pressureEpisodes = new Set<string>();

  const reportError = (category: string, code: string, message: string, scopeLabel?: string): void => {
    try {
      opts.onError?.({ category, code, message, ...(scopeLabel ? { scopeLabel } : {}) });
    } catch (e) {
      swallow(`sprites-sandbox: ${code} report`, e);
    }
  };

  async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new Error(`sprites ${what}: ${spritesErrorDetail(e)}`, { cause: e });
    }
  }
  async function spawnExec(name: string, argv: string[], stdin: Buffer, deadlineMs: number): Promise<RawExec> {
    const cmd = sprite(name).spawn(argv[0]!, argv.slice(1));
    let submissionStarted = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const collect = (stream: Readable, into: Buffer[]): Promise<void> =>
      new Promise((resolve) => {
        stream.on("data", (chunk: Buffer) => into.push(chunk));
        stream.once("end", resolve);
      });
    const exited = new Promise<number>((resolve, reject) => {
      const fail = (detail: string): void => {
        const phase = submissionStarted ? "script submission started; execution unknown" : "script not submitted";
        reject(new Error(`sprites exec: WebSocket error (${phase}): ${detail}`));
      };
      cmd.on("error", (e) => fail(withoutSdkUrl(e.message)));
      cmd.once("exit", (code) => {
        if (code < 0) fail("connection closed without an exit status");
        else resolve(code);
      });
      cmd.once("spawn", () => {
        submissionStarted = true;
        cmd.stdin.end(stdin);
      });
    });
    try {
      const [rc] = await withTimeout(
        () => Promise.all([exited, collect(cmd.stdout, out), collect(cmd.stderr, err)]),
        deadlineMs,
        "sprites exec",
      );
      return { rc, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
    } catch (e) {
      cmd.kill();
      throw e;
    } finally {
      cmd.close();
    }
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
      `timeout ${timeoutSec} sh ${body} > ${out} 2> ${err}; __rc=$?; printf '%s %s %s %s %s\\n' "$__rc" "$(wc -c < ${out})" "$(wc -c < ${err})" "${psi}" "${load}"; cat ${out} ${err}; rm -f ${out} ${err} ${body}`;
    const r = await spawnExec(
      name,
      ["sh", "-c", SCRIPT_RUNNER],
      Buffer.from(wrapped, "utf8"),
      timeoutSec * 1000 + EXIT_GRACE_MS,
    );
    const nl = r.stdout.indexOf(0x0a);
    const header = (nl < 0 ? r.stdout : r.stdout.subarray(0, nl)).toString("utf8").trim().split(/\s+/);
    if (r.rc !== 0 || nl < 0 || header.length < 3) {
      const detail = r.stderr.toString("utf8").trim() || r.stdout.toString("utf8").slice(0, 120);
      throw new Error(`sprites exec ${name}: bad envelope (rc=${r.rc}): ${detail}`);
    }
    const pressure = header.length === 6 ? parsePressure(header[3]!, header[4]!, header[5]!) : undefined;
    if (pressure) notePressure(name, pressure);
    const code = Number.parseInt(header[0]!, 10);
    const outLen = Number.parseInt(header[1]!, 10);
    const errLen = Number.parseInt(header[2]!, 10);
    const start = nl + 1;
    const outBuf = r.stdout.subarray(start, start + outLen);
    const errBuf = r.stdout.subarray(start + outLen, start + outLen + errLen);
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

  function notePressure(name: string, pressure: ExecPressure): void {
    if (pressure.ioFull60 >= PRESSURE_RECORD_FULL60 && !pressureEpisodes.has(name)) {
      pressureEpisodes.add(name);
      reportError(
        "agent_computer",
        "io_pressure_high",
        `sprite ${name}: io pressure full avg60=${pressure.ioFull60}% (load ${pressure.load1}) — disk-bound work is stalling`,
        sandbox.scopeFor(name),
      );
    } else if (pressure.ioFull60 < PRESSURE_CLEAR_FULL60) {
      pressureEpisodes.delete(name);
    }
  }

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    const fs = sprite(name).filesystem();
    const tmp = `${absPath}.part.${randomUUID()}`;
    await attempt(`write ${absPath} failed`, async () => {
      await fs.writeFile(tmp, Buffer.from(data));
      await fs.rename(tmp, absPath);
    });
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    try {
      return await sprite(name).filesystem().readFile(absPath, null);
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return null;
      throw new Error(`sprites read ${absPath} failed: ${spritesErrorDetail(e)}`, { cause: e });
    }
  }

  const egressProxyHost = opts.egressProxyUrl
    ? new URL(opts.egressProxyUrl).hostname.toLowerCase().replace(/\.$/, "")
    : "";

  async function ensureEgressPolicy(name: string): Promise<void> {
    const rules = [{ domain: egressProxyHost, action: "allow" as const }];
    const want = JSON.stringify(rules);
    if (egressPolicyByName.get(name) === want) return;
    const s = sprite(name);
    await attempt(`egress policy ${name}`, () => retrySpritesControl(() => s.updateNetworkPolicy({ rules })));
    const got = await attempt(`egress policy readback ${name}`, () => retrySpritesControl(() => s.getNetworkPolicy()));
    const actual = got.rules ?? [];
    const bound =
      actual.length === 1 &&
      actual[0]!.action?.toLowerCase() === "allow" &&
      (actual[0]!.domain ?? "").toLowerCase().replace(/\.$/, "") === egressProxyHost;
    if (!bound)
      throw new Error(`sprites egress policy ${name}: readback mismatch (${JSON.stringify(got).slice(0, 200)})`);
    egressPolicyByName.set(name, want);
  }

  async function adopt(name: string): Promise<void> {
    if (opts.memoryMb !== undefined && !resourcesApplied.has(name)) {
      await attempt(`resources policy ${name}`, () =>
        sprite(name).updateResourcesPolicy({ memory: { limitMB: opts.memoryMb! } }),
      );
      resourcesApplied.add(name);
    }
    live.add(name);
  }

  async function deleteSprite(name: string): Promise<void> {
    try {
      await retrySpritesControl(() => client.deleteSprite(name));
    } catch (e) {
      if (!isMissing(e)) throw new Error(`sprites delete ${name}: ${spritesErrorDetail(e)}`, { cause: e });
    }
  }

  async function settleStream(stream: AsyncIterable<StreamMessage>, what: string): Promise<void> {
    let failure: string | undefined;
    for await (const msg of stream) {
      if (msg.type === "error") failure = msg.error ?? msg.data ?? "error";
      else if (msg.type === "complete") failure = undefined;
    }
    if (failure !== undefined) throw new Error(`${what}: ${failure}`);
  }

  async function latestCheckpoint(name: string): Promise<Checkpoint | undefined> {
    const list = await retrySpritesControl(() => sprite(name).listCheckpoints());
    return list
      .filter((c) => c.id !== "Current" && !c.health)
      .sort((a, b) => b.createTime.getTime() - a.createTime.getTime())[0];
  }

  async function restoreCheckpoint(name: string, checkpointId: string): Promise<void> {
    await settleStream(await sprite(name).restoreCheckpoint(checkpointId), `sprites restore ${name} ${checkpointId}`);
  }

  async function captureCheckpoint(name: string): Promise<string> {
    await settleStream(await sprite(name).createCheckpoint(CHECKPOINT_COMMENT), `sprites checkpoint ${name}`);
    const latest = await latestCheckpoint(name);
    if (!latest) throw new Error(`sprites checkpoint ${name}: completed but no checkpoint is listed`);
    return latest.id;
  }

  const forget = (name: string): void => {
    live.delete(name);
    resourcesApplied.delete(name);
    pressureEpisodes.delete(name);
    egressPolicyByName.delete(name);
  };

  async function restart(name: string, ctx: { initializationPending: boolean }): Promise<void> {
    if (ctx.initializationPending)
      throw new Error(`sprites ${name}: initialization is incomplete; refusing to capture or restore a checkpoint`);
    forget(name);
    const s = sprite(name);
    const restartFailure = await s.restart().then(
      () => undefined,
      (e) => spritesErrorDetail(e),
    );
    if (restartFailure === undefined) return;
    let check: SpriteCheck;
    try {
      check = await retrySpritesControl(() => s.check());
    } catch (e) {
      throw new Error(
        `sprites restart ${name}: ${restartFailure}; check failed: ${spritesErrorDetail(e)}; no checkpoint was restored`,
        { cause: e },
      );
    }
    if (check.status !== "unhealthy") {
      throw new Error(
        `sprites restart ${name}: ${restartFailure}; the health check reports no fault, so no checkpoint was restored`,
      );
    }
    const fault = `check reports ${describeCheck(check)}`;
    let restored: Checkpoint | undefined;
    try {
      restored = await latestCheckpoint(name);
      if (restored) await restoreCheckpoint(name, restored.id);
    } catch (e) {
      throw new Error(
        `sprites restart ${name}: ${restartFailure}; ${fault}; checkpoint restore failed: ${errMessage(e)}`,
        {
          cause: e,
        },
      );
    }
    if (!restored) throw new Error(`sprites restart ${name}: ${restartFailure}; ${fault}; no checkpoint to restore`);
    reportError(
      "agent_computer",
      "checkpoint_restored",
      `sprite ${name}: restart failed (${restartFailure}); ${fault}; restored checkpoint ${restored.id} from ${restored.createTime.toISOString()}`,
      sandbox.scopeFor(name),
    );
  }

  const sandbox = createProviderSandbox(
    workspace,
    {
      backend: "sprites",
      homeDir: HOME_DIR,
      os: "Ubuntu (25.10 for newly created sprites; existing sprites keep the release they were created with) — Fly Sprite microVM: the whole disk persists and idle sprites sleep; background processes are held awake while they run but do not survive a cold wake or restart",
      tools: ["git", "curl", "jq", "tar", "python3"],
      cpus: SPRITE_CPUS,
      ...(opts.memoryMb !== undefined ? { memoryMb: opts.memoryMb } : {}),
      diskGb: SPRITE_DISK_GB,
      egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
      combineRoundTrips: true,
      exec: execRaw,
      writeAbsBytes,
      readAbsBytes,
      async inspect(name) {
        let check: SpriteCheck;
        try {
          check = await retrySpritesControl(() => sprite(name).check());
        } catch (e) {
          if (isMissing(e)) return null;
          throw new Error(`sprites check ${name}: ${spritesErrorDetail(e)}`, { cause: e });
        }
        await adopt(name);
        return { state: "running", detail: describeCheck(check) };
      },
      async create(name) {
        await attempt(`create ${name}`, () => client.createSprite(name, { waitForCapacity: true }));
        await adopt(name);
      },
      resume: adopt,
      async destroy(name) {
        forget(name);
        await deleteSprite(name);
      },
      isLive: (name) => live.has(name),
      forget,
      restart,
      ...(opts.egressProxyUrl ? { ensureEgress: ensureEgressPolicy } : {}),
      checkpoints: { machineBound: true, capture: captureCheckpoint, restore: restoreCheckpoint },
    },
    opts,
    opts.store,
  );

  return {
    ...sandbox,
    async startProcess(handle, command, spOpts) {
      const started = await sandbox.startProcess!(handle, command, spOpts);
      try {
        const r = await execRaw(handle.id, processKeepaliveScript(started.processId), KEEPALIVE_TIMEOUT_SEC);
        if (r.code !== 0 || !r.stdout.includes("OK")) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      } catch (e) {
        reportError(
          "agent_computer",
          "process_keepalive_failed",
          `sprite ${handle.id}: process ${started.processId} runs without a Tasks hold and may freeze when the sprite idles: ${errMessage(e)}`,
          sandbox.scopeFor(handle.id),
        );
      }
      return started;
    },
    async computerStatus(scopeId) {
      const status = await sandbox.computerStatus!(scopeId);
      return status.recovery ? { ...status, recovery: { ...status.recovery, checkpointExpiresAtMs: null } } : status;
    },
  };
}
