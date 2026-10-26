import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createProviderSandbox, type SandboxShared, type StoredSandboxRecord } from "./provider-sandbox.ts";
import {
  SuperserveSandboxGoneError,
  type SuperserveClient,
  type SuperserveNetwork,
  type SuperserveSandboxInfo,
  type SuperserveSession,
} from "./superserve-client.ts";
import type { ExecResult, Sandbox } from "./sandbox.ts";

const HOME_DIR = "/root";
const DEFAULT_IDLE_PAUSE_SEC = 15 * 60;
const DEFAULT_KEEP_WARM_SEC = 3600;
const RETENTION_SEC = 30 * 24 * 3600;
const SCRATCH_IDLE_PAUSE_SEC = 10 * 60;
const SCRATCH_RETENTION_SEC = 24 * 3600;
const TIMEOUT_EXIT_CODE = 124;
const TIMEOUT_KILLED_EXIT_CODE = 137;
const KILL_AFTER_SEC = 10;
const OUTPUT_CAP_BYTES = 2 * 1024 * 1024;
const TRUNCATED_NOTICE = "[superserve: output truncated at 2 MiB; redirect large output to a file]";
const TEMPLATE_TOOLS = ["git", "curl", "jq", "tar", "python3", "node", "npm", "gh", "aws", "claude", "codex", "x-api"];
const PAUSED_STATES = new Set(["paused", "pausing"]);

export const SUPERSERVE_METADATA = {
  scope: "qm_scope",
  template: "qm_template",
  epoch: "qm_config_epoch",
} as const;

export interface StoredSuperserveSandbox extends StoredSandboxRecord {
  sandboxId?: string;
}

export interface StoredConfigEpoch {
  generation: number;
}

const CONFIG_EPOCH_LOCK = "superserve-config-epoch";

export function createConfigEpochResolver(
  store: DurableMap<StoredConfigEpoch>,
  generationKey: string,
  lock: AdvisoryLock,
): () => Promise<number> {
  let pending: Promise<number> | undefined;
  const claim = (): Promise<number> =>
    lock.withLock(CONFIG_EPOCH_LOCK, async () => {
      const stored = await store.get(generationKey);
      if (stored) return stored.generation;
      const generation = (await store.entries()).reduce((high, [, seen]) => Math.max(high, seen.generation), 0) + 1;
      await store.put(generationKey, { generation });
      return (await store.get(generationKey))?.generation ?? generation;
    });
  return () => {
    pending ??= claim().catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}

export interface SuperserveSandboxOptions extends SandboxShared {
  client: SuperserveClient;
  template: string;
  configEpoch: number | (() => Promise<number>);
  store: DurableMap<StoredSuperserveSandbox>;
}

const isConflict = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { statusCode?: unknown }).statusCode === 409;

const normalizedNetwork = (value: SuperserveNetwork | undefined): string =>
  JSON.stringify([
    [...(value?.allowOut ?? [])].map((rule) => rule.trim()).sort(),
    [...(value?.denyOut ?? [])].map((rule) => rule.trim()).sort(),
  ]);

function spooledScript(script: string, timeoutSec: number): string {
  const capture = (file: string): string => `{ head -c ${OUTPUT_CAP_BYTES} >"${file}"; wc -c >"${file}.rest"; }`;
  return [
    `o=$(mktemp) && e=$(mktemp) && r=$(mktemp) || exit 1`,
    `{ { timeout -k ${KILL_AFTER_SEC} ${timeoutSec} sh -c ${shq(script)}; echo $? >"$r"; } 2>&1 1>&3 3>&- | ${capture("$e")}; } 3>&1 | ${capture("$o")}`,
    `cat "$o"`,
    `cat "$e" >&2`,
    `if [ "$(cat "$o.rest")" -gt 0 ] || [ "$(cat "$e.rest")" -gt 0 ]; then echo ${shq(TRUNCATED_NOTICE)} >&2; fi`,
    `rc=$(cat "$r")`,
    `rm -f "$o" "$e" "$r" "$o.rest" "$e.rest"`,
    `exit "\${rc:-1}"`,
  ].join("; ");
}

export function createSuperserveSandbox(workspace: WorkspaceStore, opts: SuperserveSandboxOptions): Sandbox {
  const { client, template } = opts;
  const idlePauseSec = opts.idleParkSec ?? DEFAULT_IDLE_PAUSE_SEC;
  const keepWarmSec = Math.max(opts.keepWarmSec ?? DEFAULT_KEEP_WARM_SEC, idlePauseSec);
  const egressProxyHost = opts.egressProxyUrl ? new URL(opts.egressProxyUrl).hostname : undefined;
  const network: SuperserveNetwork | undefined = egressProxyHost
    ? { allowOut: [egressProxyHost], denyOut: ["0.0.0.0/0"] }
    : undefined;
  const expectedNetwork = normalizedNetwork(network);

  const idByName = new Map<string, string>();
  const live = new Map<string, SuperserveSession>();
  const egressVerified = new Set<string>();

  const configEpoch = async (): Promise<number> =>
    typeof opts.configEpoch === "function" ? opts.configEpoch() : opts.configEpoch;
  void configEpoch().catch(swallowAs("superserve-sandbox: claim config generation", undefined));
  const newerCore = async (info: SuperserveSandboxInfo): Promise<boolean> =>
    Number(info.metadata[SUPERSERVE_METADATA.epoch] ?? 0) > (await configEpoch());
  const stamp = async (name: string): Promise<Record<string, string>> => ({
    [SUPERSERVE_METADATA.scope]: name,
    [SUPERSERVE_METADATA.template]: template,
    [SUPERSERVE_METADATA.epoch]: String(await configEpoch()),
  });

  const listed = (name: string): Promise<SuperserveSandboxInfo[]> => client.list({ [SUPERSERVE_METADATA.scope]: name });

  async function retire(info: SuperserveSandboxInfo, category: string, code: string, reason: string): Promise<null> {
    await client.kill(info.id);
    opts.onError?.({
      category,
      code,
      message: `sandbox ${info.id} ${reason}; it was destroyed and the next provision creates a replacement`,
    });
    return null;
  }

  async function applyNetwork(name: string, info: SuperserveSandboxInfo): Promise<boolean> {
    if (normalizedNetwork(info.network) === expectedNetwork) return true;
    try {
      await client.update(info.id, { network: network ?? { allowOut: [], denyOut: [] } });
    } catch (err) {
      if (isConflict(err)) return false;
      throw err;
    }
    const after = (await listed(name)).find((s) => s.id === info.id);
    return normalizedNetwork(after?.network) === expectedNetwork;
  }

  async function reconcile(name: string, info: SuperserveSandboxInfo): Promise<SuperserveSandboxInfo | null> {
    if (await newerCore(info)) return info;
    if (info.metadata[SUPERSERVE_METADATA.template] !== template)
      return retire(
        info,
        "sandbox_template",
        "template_changed",
        `was built from template ${info.metadata[SUPERSERVE_METADATA.template] ?? "unknown"}, not ${template}`,
      );
    if (!(await applyNetwork(name, info)))
      return retire(info, "sandbox_egress", "policy_changed", "could not take the configured egress policy");
    await client.update(info.id, {
      metadata: { ...info.metadata, ...(await stamp(name)) },
      autoDeleteSeconds: RETENTION_SEC,
    });
    return info;
  }

  async function session(name: string): Promise<SuperserveSession> {
    const cached = live.get(name);
    if (cached) return cached;
    const id = idByName.get(name) ?? (await listed(name))[0]?.id;
    if (!id) throw new Error(`superserve sandbox for ${name} is gone; the next provision creates a replacement`);
    const connected = await client.connect(id);
    idByName.set(name, id);
    live.set(name, connected);
    return connected;
  }

  function forget(name: string): void {
    live.delete(name);
    idByName.delete(name);
  }

  async function withSession<T>(name: string, action: (s: SuperserveSession) => Promise<T>): Promise<T> {
    try {
      return await action(await session(name));
    } catch (err) {
      if (!(err instanceof SuperserveSandboxGoneError)) throw err;
      forget(name);
      throw new Error(`superserve sandbox for ${name} is gone; the next provision creates a replacement`, {
        cause: err,
      });
    }
  }

  const exec = (name: string, script: string, timeoutSec: number): Promise<ExecResult> =>
    withSession(name, async (s) => {
      const t0 = Date.now();
      const r = await s.run(spooledScript(`export HOME=${shq(HOME_DIR)}; ${script}`, timeoutSec), {
        timeoutMs: timeoutSec * 1000 + 30_000,
        maxOutputBytes: OUTPUT_CAP_BYTES,
      });
      return {
        stdout: r.stdout,
        stderr: r.truncated ? `${r.stderr}\n${TRUNCATED_NOTICE}` : r.stderr,
        code: r.exitCode,
        timedOut:
          r.exitCode === TIMEOUT_EXIT_CODE ||
          (r.exitCode === TIMEOUT_KILLED_EXIT_CODE && Date.now() - t0 >= timeoutSec * 1000),
      };
    });

  async function create(name: string, { scratch }: { scratch: boolean }): Promise<void> {
    const created = await client.create({
      name,
      metadata: await stamp(name),
      template,
      timeoutSeconds: scratch ? SCRATCH_IDLE_PAUSE_SEC : idlePauseSec,
      autoDeleteSeconds: scratch ? SCRATCH_RETENTION_SEC : RETENTION_SEC,
      ...(network ? { network } : {}),
    });
    idByName.set(name, created.id);
    live.set(name, created);
  }

  async function destroy(name: string): Promise<void> {
    const ids = new Set((await listed(name)).map((s) => s.id));
    const cached = idByName.get(name);
    if (cached) ids.add(cached);
    for (const id of ids) await client.kill(id);
    forget(name);
  }

  async function park(name: string, { keepWarm }: { keepWarm: boolean }): Promise<void> {
    const cached = live.get(name);
    if (!cached) return;
    const info = (await listed(name)).find((s) => s.id === cached.id);
    if (!info) return forget(name);
    if (await newerCore(info)) return;
    await withSession(name, (s) => (keepWarm ? client.update(s.id, { timeoutSeconds: keepWarmSec }) : s.pause()));
  }

  async function ensureEgress(name: string): Promise<void> {
    const id = idByName.get(name);
    if (id && egressVerified.has(id)) return;
    const info = (await listed(name)).find((s) => s.id === id);
    if (!info || !(await applyNetwork(name, info)))
      throw new Error(
        `superserve egress ${name}: sandbox network is ${JSON.stringify(info?.network)}, expected ${JSON.stringify(network)}; destroy the sandbox so it is recreated with the allow list`,
      );
    egressVerified.add(info.id);
  }

  return createProviderSandbox(
    workspace,
    {
      backend: "superserve",
      homeDir: HOME_DIR,
      os: "Ubuntu — Superserve sandbox (disk persists across pause/resume; publish durable work to git or Files)",
      tools: TEMPLATE_TOOLS,
      egressEnforcement: egressProxyHost ? "domain" : "none",
      exec,
      writeAbsBytes: (name, absPath, data) => withSession(name, (s) => s.writeFileBytes(absPath, data)),
      readAbsBytes: (name, absPath) => withSession(name, (s) => s.readFileBytes(absPath)),
      async inspect(name) {
        for (const candidate of await listed(name)) {
          const info = await reconcile(name, candidate);
          if (!info) continue;
          idByName.set(name, info.id);
          return {
            state: PAUSED_STATES.has(info.status) ? "parked" : "running",
            detail: `superserve sandbox ${info.id} ${info.status}${info.autoDeleteAtMs ? ` (deleted at ${new Date(info.autoDeleteAtMs).toISOString()} unless resumed)` : ""}`,
          };
        }
        forget(name);
        return null;
      },
      create,
      async resume(name) {
        live.delete(name);
        await session(name);
      },
      park,
      destroy,
      isLive: (name) => live.has(name),
      forget,
      async restart(name) {
        await withSession(name, (s) => s.pause());
        live.delete(name);
        await session(name);
      },
      ...(egressProxyHost ? { ensureEgress } : {}),
    },
    opts,
    opts.store,
  );
}
