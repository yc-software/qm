import { killableScript, killScript } from "./exec-kill.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createSecretValueMasker } from "../security/secret-masking.ts";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import { shq } from "../util/shell.ts";
import { createExecProcessSessions, SUPERVISOR_PROCESS_ROOT } from "./exec-process-session.ts";
import { createBackendBlobStaging, type BlobStagingOptions, posixJoin } from "./exec-file-ops.ts";
import { NONINTERACTIVE_ENV } from "./sandbox-env.ts";
import type {
  Sandbox,
  SandboxHandle,
  ExecOptions,
  ExecResult,
  StartProcessOptions,
  AgentComputerExportEntry,
} from "./sandbox.ts";

export interface SupervisorTrust {
  backend: string;
  identity: string;
  acceptedAt: number;
}

interface SupervisedSandboxDeps extends BlobStagingOptions {
  workspace: WorkspaceStore;
  trust: DurableMap<SupervisorTrust>;
  lock: AdvisoryLock;
  apiBaseUrl?: string;
  blobTransfer?: BlobTransferStore;
}

const source = (): Buffer => readFileSync(new URL("./execution-supervisor.py", import.meta.url));
const supervisorPath = "/opt/qm-supervisor/execution-supervisor.py";
const requestRoot = "/dev/shm/qm-supervisor";
const safeHandle = (handle: SandboxHandle): SandboxHandle => ({ ...handle, env: {} });
const python = (code: string): string => `/usr/bin/python3 -I -c ${shq(code)}`;

export function createSupervisedSandbox(raw: Sandbox, deps: SupervisedSandboxDeps): Sandbox {
  const transport = raw.supervisorTransport;
  const trustedOrigins = deps.apiBaseUrl ? [new URL(deps.apiBaseUrl).origin] : [];
  const requireTransport = () => {
    if (!transport) throw new Error(`${raw.profile.backend} does not support supervised execution`);
    return transport;
  };
  const check = (result: ExecResult): ExecResult => {
    if (result.code !== 0 || result.timedOut) throw new Error(result.stderr.trim() || "Supervisor operation failed");
    return result;
  };
  async function prepare(handle: SandboxHandle): Promise<void> {
    const io = requireTransport();
    const identity = await io.identity(handle);
    if (!identity) throw new Error("Provider did not identify the physical sandbox");
    await deps.lock.withLock(`supervisor:${raw.profile.backend}:${identity}`, async () => {
      const key = `${raw.profile.backend}:${identity}`;
      const trusted = await deps.trust.get(key);
      if (!trusted && !(await io.isFresh(handle))) {
        throw new Error(
          "This computer predates execution isolation. Move its workspace to a newly created computer before running commands; its files have been preserved.",
        );
      }
      await io.ensureDependencies(handle);
      const bytes = source();
      const hash = createHash("sha256").update(bytes).digest("hex");
      check(
        await io.run(
          safeHandle(handle),
          `test "$(id -u)" = 0 && command -v python3 && command -v bwrap && command -v setpriv && install -d -m 755 /opt/qm-supervisor && install -d -m 700 ${requestRoot} ${shq(SUPERVISOR_PROCESS_ROOT)}`,
          { timeoutMs: 30_000 },
        ),
      );
      const probe = await io.run(
        safeHandle(handle),
        `test -f ${supervisorPath} && test "$(sha256sum ${supervisorPath} | cut -d ' ' -f 1)" = ${shq(hash)}`,
        { timeoutMs: 10_000 },
      );
      if (probe.code !== 0) {
        const temp = `${supervisorPath}.${randomUUID()}`;
        await io.writeFile(safeHandle(handle), temp, bytes);
        check(
          await io.run(safeHandle(handle), `chmod 555 ${shq(temp)} && mv -f ${shq(temp)} ${supervisorPath}`, {
            timeoutMs: 10_000,
          }),
        );
      }
      if (!trusted) {
        const workspace = JSON.stringify(handle.rootDir);
        check(
          await io.run(
            safeHandle(handle),
            python(
              `import os,stat,pathlib\np=${workspace}\nfor parent in pathlib.Path(p).parents:\n s=parent.lstat()\n if not stat.S_ISDIR(s.st_mode): raise ValueError("Workspace ancestor is not a directory")\n if not s.st_mode & stat.S_IXOTH:\n  os.chown(parent,-1,61001,follow_symlinks=False)\n  os.chmod(parent,stat.S_IMODE(s.st_mode)|stat.S_IXGRP,follow_symlinks=False)\nfor root,dirs,files in os.walk(p,followlinks=False):\n for path in [root]+[os.path.join(root,n) for n in dirs+files]:\n  s=os.lstat(path)\n  if stat.S_ISLNK(s.st_mode): continue\n  os.chown(path,-1,61001,follow_symlinks=False)\n  os.chmod(path,stat.S_IMODE(s.st_mode)|stat.S_IRGRP|stat.S_IWGRP|(stat.S_IXGRP|stat.S_ISGID if stat.S_ISDIR(s.st_mode) else 0),follow_symlinks=False)`,
            ),
            { timeoutMs: 120_000 },
          ),
        );
        await deps.trust.put(key, { backend: raw.profile.backend, identity, acceptedAt: Date.now() });
      }
      await io.acceptTrusted?.(safeHandle(handle));
    });
  }
  async function stage(handle: SandboxHandle, command: string, opts?: ExecOptions, processOpts?: StartProcessOptions) {
    await prepare(handle);
    opts?.signal?.throwIfAborted();
    const io = requireTransport();
    const path = `${requestRoot}/${randomUUID()}.json`;
    const timeoutMs = opts?.timeoutMs ?? 600_000;
    const request = {
      command,
      workspace: handle.rootDir,
      cwd: processOpts?.cwd ?? handle.rootDir,
      env: { ...Object.fromEntries(NONINTERACTIVE_ENV), ...handle.env, ...processOpts?.env, ...opts?.credentials?.env },
      files: (opts?.credentials?.files ?? []).map(({ path, data }) => ({
        path,
        contentBase64: Buffer.from(data).toString("base64"),
      })),
      timeoutMs,
      trustedHttpOrigins: trustedOrigins,
      upstreamProxy: handle.env?.HTTPS_PROXY ?? handle.env?.https_proxy,
    };
    check(
      await io.run(
        safeHandle(handle),
        `nohup sh -c ${shq(`sleep 60; rm -f ${shq(path)}`)} </dev/null >/dev/null 2>&1 &`,
        { timeoutMs: 10_000 },
      ),
    );
    await io.writeFile(safeHandle(handle), path, Buffer.from(JSON.stringify(request)));
    return {
      command: `/usr/bin/python3 -I ${supervisorPath} --request ${shq(path)}`,
      cleanup: async () => check(await io.run(safeHandle(handle), `rm -f ${shq(path)}`, { timeoutMs: 10_000 })),
    };
  }
  async function run(handle: SandboxHandle, command: string, opts?: ExecOptions): Promise<ExecResult> {
    const request = await stage(handle, command, opts);
    const executionId = randomUUID();
    const cancelled = `${requestRoot}/${executionId}.cancelled`;
    const io = requireTransport();
    let cancellation: Promise<void> | undefined;
    const cancel = (): void => {
      cancellation ??= io
        .run(safeHandle(handle), `touch ${shq(cancelled)}; ${killScript(executionId)}`, { timeoutMs: 15_000 })
        .then((result) => {
          check(result);
        });
      void cancellation.catch(() => undefined);
    };
    opts?.signal?.addEventListener("abort", cancel, { once: true });
    try {
      opts?.signal?.throwIfAborted();
      const result = await io.run(
        safeHandle(handle),
        killableScript(`if test -f ${shq(cancelled)}; then exit 130; fi; ${request.command}`, executionId),
        {
          timeoutMs: (opts?.timeoutMs ?? 600_000) + 15_000,
        },
      );
      if (cancellation) await cancellation;
      opts?.signal?.throwIfAborted();
      check(result);
      const value = JSON.parse(result.stdout) as ExecResult;
      if (
        typeof value.stdout !== "string" ||
        typeof value.stderr !== "string" ||
        typeof value.code !== "number" ||
        typeof value.timedOut !== "boolean"
      )
        throw new Error("Invalid supervisor response");
      const mask = createSecretValueMasker({ ...handle.env, ...opts?.credentials?.env });
      return { ...value, stdout: mask(value.stdout), stderr: mask(value.stderr) };
    } catch (error) {
      cancel();
      await cancellation;
      throw error;
    } finally {
      opts?.signal?.removeEventListener("abort", cancel);
      await request.cleanup();
      await io.run(safeHandle(handle), `rm -f ${shq(cancelled)}`, { timeoutMs: 10_000 });
    }
  }
  const sessions = createExecProcessSessions(
    {
      run: (handle, command, opts) => requireTransport().run(safeHandle(handle), command, opts),
    },
    SUPERVISOR_PROCESS_ROOT,
  );
  async function startProcess(handle: SandboxHandle, command: string, opts?: StartProcessOptions) {
    const request = await stage(handle, command, { timeoutMs: 24 * 60 * 60_000 }, opts);
    try {
      const started = await sessions.startProcess(safeHandle(handle), `${request.command} --stream`, { cwd: "/" });
      try {
        await requireTransport().processStarted?.(safeHandle(handle), started.processId);
      } catch (error) {
        await sessions.signalProcess(safeHandle(handle), started.processId, "KILL");
        throw error;
      }
      return started;
    } catch (error) {
      await request.cleanup();
      throw error;
    }
  }
  async function writeFileBytes(handle: SandboxHandle, rel: string, data: Uint8Array): Promise<void> {
    const path = posixJoin(handle.rootDir, rel);
    const temporary = `${path}.qm-write-${randomUUID()}`;
    try {
      check(
        await run(
          safeHandle(handle),
          python(
            `import pathlib\np=pathlib.Path(${JSON.stringify(temporary)})\np.parent.mkdir(parents=True,exist_ok=True)\np.touch(exist_ok=False)`,
          ),
        ),
      );
      for (let offset = 0; offset < data.length; offset += 4 * 1024 * 1024) {
        const chunk = data.subarray(offset, offset + 4 * 1024 * 1024);
        check(
          await run(safeHandle(handle), `cat "$HOME/.qm-upload" >> ${shq(temporary)}`, {
            credentials: { env: {}, files: [{ path: ".qm-upload", data: chunk }] },
          }),
        );
      }
      check(
        await run(
          safeHandle(handle),
          python(`import os\nos.replace(${JSON.stringify(temporary)},${JSON.stringify(path)})`),
        ),
      );
    } finally {
      check(await run(safeHandle(handle), `rm -f -- ${shq(temporary)}`));
    }
  }
  async function readFileBytes(handle: SandboxHandle, rel: string): Promise<Uint8Array | null> {
    const path = posixJoin(handle.rootDir, rel);
    const result = await run(
      safeHandle(handle),
      python(
        `import pathlib,base64,sys\np=pathlib.Path(${JSON.stringify(path)})\nif not p.exists(): sys.exit(44)\nprint(base64.b64encode(p.read_bytes()).decode())`,
      ),
    );
    if (result.code === 44) return null;
    return Buffer.from(check(result).stdout.trim(), "base64");
  }
  async function listDir(handle: SandboxHandle, rel: string): Promise<string[]> {
    const path = posixJoin(handle.rootDir, rel);
    return JSON.parse(
      check(
        await run(
          safeHandle(handle),
          python(
            `import os,json\nbase=${JSON.stringify(handle.rootDir)}\nout=[]\nfor root,dirs,files in os.walk(${JSON.stringify(path)},followlinks=False):\n for name in files:\n  p=os.path.join(root,name)\n  if not os.path.islink(p): out.append(os.path.relpath(p,base))\nprint(json.dumps(out))`,
          ),
        ),
      ).stdout,
    );
  }
  async function removeDir(handle: SandboxHandle, rel: string): Promise<void> {
    if (!rel.replaceAll("/", "")) return;
    check(await run(safeHandle(handle), `rm -rf -- ${shq(posixJoin(handle.rootDir, rel))}`));
  }
  async function exportFiles(
    handle: SandboxHandle,
    opts: Parameters<NonNullable<Sandbox["exportFiles"]>>[1] = {},
  ): Promise<AgentComputerExportEntry[]> {
    if (opts.include && !opts.include.includes("workspace")) return [];
    const selection = JSON.stringify(
      opts.includePaths?.map((path) => posixJoin(handle.rootDir, path)) ?? [handle.rootDir],
    );
    const output = check(
      await run(
        safeHandle(handle),
        python(
          `import os,stat,json,base64\nbase=${JSON.stringify(handle.rootDir)}\npaths=${selection}\nout=[]\nseen=set()\nfor start in paths:\n candidates=[start] if os.path.isfile(start) else []\n for root,dirs,files in os.walk(start,followlinks=${opts.followSymlinks ? "True" : "False"}):\n  real=os.path.realpath(root)\n  if real in seen: dirs[:]=[]; continue\n  seen.add(real)\n  if ${opts.keepContentCaches ? "False" : "True"}: dirs[:]=[d for d in dirs if d not in ['.cache','__pycache__']]\n  candidates.extend(os.path.join(root,name) for name in files)\n for path in candidates:\n  if os.path.islink(path) and ${opts.followSymlinks ? "False" : "True"}: continue\n  try:\n   with open(path,'rb') as stream:\n    info=os.fstat(stream.fileno())\n    if not stat.S_ISREG(info.st_mode): continue\n    out.append({'path':os.path.relpath(path,base),'mode':stat.S_IMODE(info.st_mode),'data':base64.b64encode(stream.read()).decode()})\n  except FileNotFoundError: pass\nprint(json.dumps(out))`,
        ),
      ),
    );
    const entries = JSON.parse(output.stdout) as Array<{ path: string; mode: number; data: string }>;
    const out: AgentComputerExportEntry[] = [];
    for (const entry of entries) {
      if (opts.exclude?.({ area: "workspace", path: entry.path })) continue;
      out.push({ area: "workspace", path: entry.path, mode: entry.mode, data: Buffer.from(entry.data, "base64") });
    }
    return out;
  }
  const result: Sandbox = {
    ...raw,
    supervisorTransport: undefined,
    async provision(layers, opts) {
      const handle = await raw.provision(
        layers.filter((layer) => layer.mode === "rw"),
        { ...opts, executionMode: "isolated" },
      );
      try {
        await prepare(handle);
        await materializeRoLayers(
          deps.workspace,
          layers,
          handle,
          {
            readFile: result.readFile,
            writeFileBytes,
            exec: (command, timeoutSec) => run(safeHandle(handle), command, { timeoutMs: timeoutSec * 1000 }),
          },
          { manifest: ".ro-layers.manifest", tar: ".ro-layers.tar", label: raw.profile.backend },
        );
        return { ...handle, executionMode: "isolated" };
      } catch (error) {
        if (handle.scratch) await raw.teardown(handle, { destroy: true });
        throw error;
      }
    },
    run,
    writeFileBytes,
    writeFile: (handle, path, data) => writeFileBytes(handle, path, Buffer.from(data)),
    readFileBytes,
    async readFile(handle, path) {
      const bytes = await readFileBytes(handle, path);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },
    listDir,
    removeDir,
    async removeDirAndList(handle, remove, list) {
      await removeDir(handle, remove);
      return listDir(handle, list);
    },
    async importFiles(handle, entries) {
      for (const entry of entries) await writeFileBytes(handle, entry.path, entry.data);
    },
    exportFiles,
    startProcess,
    async startRegisteredProcess(handle, command, register, opts) {
      const result = await startProcess(handle, command, opts);
      try {
        await register(result.processId);
      } catch (error) {
        await sessions.signalProcess(handle, result.processId, "KILL");
        throw error;
      }
      return result;
    },
    readProcess: (handle, id, opts) => sessions.readProcess(safeHandle(handle), id, opts),
    writeStdin: (handle, id, data) => sessions.writeStdin(safeHandle(handle), id, data),
    signalProcess: (handle, id, signal) => sessions.signalProcess(safeHandle(handle), id, signal),
    listProcesses: (handle) => sessions.listProcesses(safeHandle(handle)),
    stageIn: undefined,
    stageOut: undefined,
  };
  const staging = (handle: SandboxHandle) =>
    createBackendBlobStaging(
      raw.profile.backend,
      (_id, command, timeoutSec) => run(safeHandle(handle), command, { timeoutMs: timeoutSec * 1000 }),
      deps,
    );
  if (deps.blobTransfer && deps.apiBaseUrl && (deps.signingSecret || deps.capabilitySecret)) {
    result.stageIn = (handle, path, id, opts) => staging(handle)!.stageIn(handle, path, id, opts);
    result.stageOut = (handle, path, opts) => staging(handle)!.stageOut(handle, path, opts);
  }
  return result;
}
