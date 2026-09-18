import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { APIError, SpritesClient, type Checkpoint, type SpriteCheck, type StreamMessage } from "@fly/sprites";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { withTimeout } from "../util/async.ts";
import { swallow, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createExecProcessSessions, processSessionDir, type ExecProcessIo } from "./exec-process-session.ts";
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
import { withConnectorSdk, type ConnectorSdkBundle } from "./connector-sdk.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import {
  createHomeSnapshotOps,
  HOME_SNAPSHOT_PRUNE,
  snapshotDue,
  type HomeSnapshotStore,
  type SnapshotBookkeeping,
} from "./home-snapshot.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import type {
  AgentComputerProfile,
  ComputerStatus,
  ExecPressure,
  ExecResult,
  Sandbox,
  SandboxHandle,
  StartProcessOptions,
  TeardownOptions,
} from "./sandbox.ts";

const HOME_DIR = "/home/sprite";
const HOME_TAR = `${HOME_DIR}/.qm-home.tar`;
export const SCRIPT_RUNNER = 's=$(mktemp) && cat > "$s" && sh "$s" </dev/null; rc=$?; rm -f "$s"; exit $rc';
const EXIT_GRACE_MS = 60_000;
const GUEST_PROBE_TIMEOUT_SEC = 15;
const KEEPALIVE_TIMEOUT_SEC = 20;
const CHECKPOINT_INTERVAL_MS = 5 * 60_000;
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

export function spritesErrorDetail(e: unknown): string {
  if (!(e instanceof APIError)) return errMessage(e);
  const parts = [e.message];
  if (e.statusCode !== undefined) parts.push(`http ${e.statusCode}`);
  if (e.errorCode && e.errorCode !== e.message) parts.push(e.errorCode);
  const retryAfter = e.getRetryAfterSeconds();
  if (retryAfter !== undefined && !e.message.includes("retry after")) parts.push(`retry after ${retryAfter}s`);
  return parts.join("; ");
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

export interface SpritesSandboxOptions extends BlobStagingOptions {
  token?: string;
  baseUrl?: string;
  namePrefix?: string;
  defaultTimeoutSec?: number;
  egressProxyUrl?: string;
  memoryMb?: number;
  checkpointIntervalMs?: number;
  snapshots?: HomeSnapshotStore;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  connectorSdk?: () => Promise<ConnectorSdkBundle>;
  layerToolFiles?: () => readonly LayerInstallFile[];
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

interface RawExec {
  rc: number;
  stdout: Buffer;
  stderr: Buffer;
}

export function createSpritesSandbox(workspace: WorkspaceStore, opts: SpritesSandboxOptions = {}): Sandbox {
  if (!opts.token) throw new Error("SANDBOX_BACKEND=sprites requires SPRITES_TOKEN");
  const client = new SpritesClient(opts.token, opts.baseUrl ? { baseURL: opts.baseUrl } : {});
  const sprite = (name: string) => client.sprite(name);
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const checkpointIntervalMs = opts.checkpointIntervalMs ?? CHECKPOINT_INTERVAL_MS;

  const ensured = new Set<string>();
  const resourcesApplied = new Set<string>();
  const egressPolicyByName = new Map<string, string>();
  const pressureEpisodes = new Set<string>();
  const checkpointBooks = new Map<string, SnapshotBookkeeping>();

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
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const collect = (stream: Readable, into: Buffer[]): Promise<void> =>
      new Promise((resolve) => {
        stream.on("data", (chunk: Buffer) => into.push(chunk));
        stream.once("end", resolve);
      });
    const exited = new Promise<number>((resolve, reject) => {
      cmd.on("error", (e) => reject(new Error(`sprites exec ${name}: ${errMessage(e)}`, { cause: e })));
      cmd.once("exit", resolve);
      cmd.once("spawn", () => cmd.stdin.end(stdin));
    });
    try {
      const [rc] = await withTimeout(
        () => Promise.all([exited, collect(cmd.stdout, out), collect(cmd.stderr, err)]),
        deadlineMs,
        `sprites exec ${name}`,
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
        base.scopeFor(name),
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

  const egressProxyHost = opts.egressProxyUrl ? new URL(opts.egressProxyUrl).hostname : undefined;

  async function ensureEgressPolicy(name: string): Promise<void> {
    const rules = [{ domain: egressProxyHost!, action: "allow" as const }];
    const want = JSON.stringify(rules);
    if (egressPolicyByName.get(name) === want) return;
    const s = sprite(name);
    await attempt(`egress policy ${name}`, () => s.updateNetworkPolicy({ rules }));
    const got = await attempt(`egress policy readback ${name}`, () => s.getNetworkPolicy());
    const norm = (d?: string) => (d ?? "").toLowerCase().replace(/\.$/, "");
    const only = got.rules?.length === 1 ? got.rules[0] : undefined;
    const bound = !!only && norm(only.domain) === norm(egressProxyHost) && only.action?.toLowerCase() === "allow";
    if (!bound)
      throw new Error(`sprites egress policy ${name}: readback mismatch (${JSON.stringify(got).slice(0, 200)})`);
    egressPolicyByName.set(name, want);
  }

  async function applyResources(name: string): Promise<void> {
    if (opts.memoryMb === undefined || resourcesApplied.has(name)) return;
    await attempt(`resources policy ${name}`, () =>
      sprite(name).updateResourcesPolicy({ memory: { limitMB: opts.memoryMb! } }),
    );
    resourcesApplied.add(name);
  }

  async function spriteExists(name: string): Promise<boolean> {
    try {
      await client.getSprite(name);
      return true;
    } catch (e) {
      if (isMissing(e)) return false;
      throw new Error(`sprites get ${name}: ${spritesErrorDetail(e)}`, { cause: e });
    }
  }

  async function deleteSprite(name: string): Promise<void> {
    try {
      await client.deleteSprite(name);
    } catch (e) {
      if (!isMissing(e)) throw new Error(`sprites delete ${name}: ${spritesErrorDetail(e)}`, { cause: e });
    }
  }

  const homeSnapshots = opts.snapshots
    ? createHomeSnapshotOps<string>({
        label: "sprites",
        homeDir: HOME_DIR,
        homeTarPath: HOME_TAR,
        prunePaths: [
          ...HOME_SNAPSHOT_PRUNE,
          ...ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => `./${rel}`),
        ],
        store: opts.snapshots,
        io: {
          runCommand: async (name, script, timeoutMs) => {
            const r = await execRaw(name, script, Math.ceil(timeoutMs / 1000));
            return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
          },
          readFileBytes: readAbsBytes,
          writeFileBytes: writeAbsBytes,
        },
      })
    : undefined;

  async function exportHome(name: string, scope: string): Promise<void> {
    if (!homeSnapshots || !(await spriteExists(name))) return;
    await homeSnapshots.snapshotHome(scope, name);
  }

  async function settleStream(stream: AsyncIterable<StreamMessage>, what: string): Promise<void> {
    let failure: string | undefined;
    for await (const msg of stream) {
      if (msg.type === "error") failure = msg.error ?? msg.data ?? "error";
      else if (msg.type === "complete") failure = undefined;
    }
    if (failure !== undefined) throw new Error(`${what}: ${failure}`);
  }

  async function createCheckpoint(name: string): Promise<void> {
    await settleStream(await sprite(name).createCheckpoint(CHECKPOINT_COMMENT), `sprites checkpoint ${name}`);
  }

  async function latestCheckpoint(name: string): Promise<Checkpoint | undefined> {
    const list = await sprite(name).listCheckpoints();
    return list
      .filter((c) => c.id !== "Current" && !c.health)
      .sort((a, b) => b.createTime.getTime() - a.createTime.getTime())[0];
  }

  async function restoreLatestCheckpoint(name: string): Promise<Checkpoint | undefined> {
    const latest = await latestCheckpoint(name);
    if (!latest) return undefined;
    await settleStream(await sprite(name).restoreCheckpoint(latest.id), `sprites restore ${name} ${latest.id}`);
    return latest;
  }

  async function checkpointIfDue(name: string, tdOpts?: TeardownOptions): Promise<void> {
    const book = checkpointBooks.get(name) ?? {};
    checkpointBooks.set(name, book);
    if (!tdOpts?.homeUnchanged) book.homeDirty = true;
    if (!snapshotDue(book, tdOpts, checkpointIntervalMs)) return;
    try {
      await createCheckpoint(name);
      book.lastSnapshotMs = Date.now();
      book.homeDirty = false;
    } catch (e) {
      reportError("sandbox_snapshot", "checkpoint_failed", errMessage(e), base.scopeFor(name));
    }
  }

  const forget = (name: string): void => {
    ensured.delete(name);
    resourcesApplied.delete(name);
    pressureEpisodes.delete(name);
    egressPolicyByName.delete(name);
    checkpointBooks.delete(name);
  };

  const base = createExecSandboxBase({
    workspace,
    label: "sprites",
    prefix,
    homeDir: HOME_DIR,
    defaultTimeoutSec,
    credentialPaths: opts.credentialPaths ?? [],
    installLayerTools: withConnectorSdk(
      HOME_DIR,
      createLayerToolInstaller(opts.layerToolFiles ?? (() => [])),
      opts.connectorSdk,
    ),
    combineLayerToolPrep: true,
    egressProxyUrl: opts.egressProxyUrl,
    deleteFailureCode: "sprite_delete_failed",
    onError: opts.onError,
    exec: execRaw,
    writeAbsBytes,
    readAbsBytes,
    async ensureResident(name, onStatus) {
      if (ensured.has(name)) return { coldStart: false };
      if (await spriteExists(name)) {
        await applyResources(name);
        ensured.add(name);
        return { coldStart: false };
      }
      try {
        onStatus?.("Creating the sandbox…");
      } catch (error) {
        void error;
      }
      await attempt(`create ${name}`, () => client.createSprite(name, { waitForCapacity: true }));
      await applyResources(name);
      const scope = base.scopeFor(name);
      let hydrated = false;
      if (homeSnapshots && scope) {
        try {
          hydrated = await homeSnapshots.hydrateHome(scope, name);
        } catch (e) {
          reportError("sandbox_hydrate", "hydrate_failed", errMessage(e), scope);
          await deleteSprite(name).catch((deleteErr) =>
            swallow("sprites-sandbox: delete after failed hydrate", deleteErr),
          );
          throw new Error(
            `sprites provision: home hydration failed (${errMessage(e)}); not risking the stored snapshot`,
            {
              cause: e,
            },
          );
        }
      }
      ensured.add(name);
      return { coldStart: !hydrated };
    },
    isProvisioned: (name) => ensured.has(name),
    async recreateScratch(name) {
      if (await spriteExists(name)) await deleteSprite(name);
      await attempt(`create ${name}`, () => client.createSprite(name, { waitForCapacity: true }));
      await applyResources(name);
      ensured.add(name);
    },
    deleteInstance: deleteSprite,
    forgetInstance: forget,
    ensureEgress: ensureEgressPolicy,
  });

  const profile: AgentComputerProfile = {
    backend: "sprites",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
    spec: {
      os: "Ubuntu (25.10 for newly created sprites; existing sprites keep the release they were created with) — Fly Sprite microVM: the whole disk persists and idle sprites sleep; background processes are held awake while they run but do not survive a cold wake or restart",
      runtimes: ["Node 24", "Python 3"],
      get tools() {
        return visibleTools(["git", "curl", "jq", "tar", "python3", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gh", "aws", "gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
      cpus: SPRITE_CPUS,
      ...(opts.memoryMb !== undefined ? { memoryMb: opts.memoryMb } : {}),
      diskGb: SPRITE_DISK_GB,
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
    combineRemoveAndList: true,
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

  async function startProcess(
    handle: SandboxHandle,
    command: string,
    spOpts?: StartProcessOptions,
  ): Promise<{ processId: string }> {
    const started = await procSessions.startProcess(handle, command, spOpts);
    try {
      const r = await execRaw(handle.id, processKeepaliveScript(started.processId), KEEPALIVE_TIMEOUT_SEC);
      if (r.code !== 0 || !r.stdout.includes("OK")) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    } catch (e) {
      reportError(
        "agent_computer",
        "process_keepalive_failed",
        `sprite ${handle.id}: process ${started.processId} runs without a Tasks hold and may freeze when the sprite idles: ${errMessage(e)}`,
        base.scopeFor(handle.id),
      );
    }
    return started;
  }

  return {
    profile,
    startProcess,
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
        await exportHome(name, scopeId);
        await deleteSprite(name);
        forget(name);
      });
    },

    ...(homeSnapshots
      ? {
          async persistHomeSnapshot(scopeId: string): Promise<void> {
            return base.provisionQueue(scopeId, async () => {
              const name = sandboxScopeName(prefix, scopeId);
              if (!(await spriteExists(name))) throw new Error(`sprites persistHomeSnapshot: no sprite for ${scopeId}`);
              await homeSnapshots.snapshotHome(scopeId, name);
            });
          },
        }
      : {}),

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const name = sandboxScopeName(prefix, scopeId);
      const [checked, latest] = await Promise.allSettled([sprite(name).check(), latestCheckpoint(name)]);
      if (checked.status === "rejected" && isMissing(checked.reason)) {
        return { machine: "no sprite provisioned yet", provisioned: false, guestResponsive: false };
      }
      const machine =
        checked.status === "fulfilled"
          ? describeCheck(checked.value)
          : `check failed: ${spritesErrorDetail(checked.reason)}`;
      const recovery: ComputerStatus["recovery"] = {
        strategy: "provider_snapshot",
        checkpointExpiresAtMs: null,
        ...(latest.status === "fulfilled" && latest.value
          ? { checkpointId: latest.value.id, checkpointAtMs: latest.value.createTime.getTime() }
          : {}),
        ...(latest.status === "rejected" ? { error: `checkpoint list failed: ${errMessage(latest.reason)}` } : {}),
      };
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
        provisioned: checked.status === "fulfilled",
        guestResponsive,
        recovery,
        ...(pressure ? { pressure } : {}),
      };
    },

    restartComputer(scopeId: string): Promise<void> {
      const name = sandboxScopeName(prefix, scopeId);
      return base.provisionQueue(`restart:${name}`, async () => {
        forget(name);
        const s = sprite(name);
        const restartFailure = await s.restart().then(
          () => undefined,
          (e) => spritesErrorDetail(e),
        );
        if (restartFailure === undefined) return;
        const fault = await s.check().then(
          (check) => (check.reason ? `check reports ${describeCheck(check)}` : undefined),
          (e) => `check failed: ${spritesErrorDetail(e)}`,
        );
        if (fault === undefined) {
          throw new Error(
            `sprites restart ${name}: ${restartFailure}; the health check reports no fault, so no checkpoint was restored`,
          );
        }
        let restored: Checkpoint | undefined;
        try {
          restored = await restoreLatestCheckpoint(name);
        } catch (e) {
          throw new Error(
            `sprites restart ${name}: ${restartFailure}; ${fault}; checkpoint restore failed: ${errMessage(e)}`,
            {
              cause: e,
            },
          );
        }
        if (!restored)
          throw new Error(`sprites restart ${name}: ${restartFailure}; ${fault}; no checkpoint to restore`);
        reportError(
          "agent_computer",
          "checkpoint_restored",
          `sprite ${name}: restart failed (${restartFailure}); ${fault}; restored checkpoint ${restored.id} from ${restored.createTime.toISOString()}`,
          base.scopeFor(name) ?? scopeId,
        );
      });
    },

    async teardown(handle: SandboxHandle, tdOpts?: TeardownOptions): Promise<void> {
      if (!handle.scratch) {
        if (tdOpts?.destroy) await exportHome(handle.id, base.scopeFor(handle.id) ?? handle.id);
        else await checkpointIfDue(handle.id, tdOpts);
      }
      return base.teardown(handle, tdOpts);
    },
  };
}
