import { randomUUID } from "node:crypto";
import {
  NotFoundError,
  Porter,
  Sandbox as PorterSdkSandbox,
  SandboxError,
  type LogLine,
  type SandboxSpec,
  type Snapshot,
  type StatusResponse,
} from "porter-sandbox";
import { sleep } from "../util/async.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { shortHash } from "../util/crypto.ts";
import type { ExecResult } from "./sandbox.ts";

const MISSING_RC = 44;
const READ_CHUNK = 256 * 1024;
const WRITE_CHUNK_B64 = 64 * 1024;
const EXIT_GRACE_MS = 60_000;
const CREATE_DEADLINE_MS = 180_000;
const CREATE_POLL_MS = 500;
const RETIRE_DEADLINE_MS = 120_000;
const RETIRE_POLL_MS = 500;
export const PORTER_CLIENT_TIMEOUT_MS = 120_000;
export const PORTER_VOLUME_REQUEST_TIMEOUT_MS = 60_000;
export const PORTER_VOLUME_READ_CHUNK = 8 * 1024 * 1024;

export type PorterSandboxStatus = Pick<StatusResponse, "name"> &
  Partial<Pick<StatusResponse, "host" | "phase" | "started_at" | "finished_at" | "exit_code" | "volume_mounts">>;

export interface PorterSandboxLike {
  readonly id: string;
  readonly phase: string | null;
  readonly tags: Record<string, string> | null;
  refresh(): Promise<PorterSandboxStatus>;
  terminate(): Promise<void>;
  logs(options?: { limit?: number }): Promise<Array<Pick<LogLine, "line"> & Partial<LogLine>>>;
}

export interface PorterVolumeLike {
  readonly id: string;
  readonly attachedTo: string[];
}

export type PorterSnapshot = Pick<Snapshot, "id" | "status"> & Partial<Snapshot>;

export interface PorterClientLike {
  sandboxes: {
    create(spec: SandboxSpec): Promise<PorterSandboxLike>;
    get(name: string): Promise<PorterSandboxLike>;
    byId(id: string): Promise<PorterSandboxLike>;
    listPage(options: {
      tags?: Record<string, string>;
      page: number;
    }): Promise<{ sandboxes: PorterSandboxLike[]; hasNextPage: boolean }>;
    raw: {
      get(id: string): Promise<{ phase: string; host?: string }>;
      exec(
        id: string,
        body: { command: string[] },
        options?: { timeoutMs?: number },
      ): Promise<{ stdout: string; stderr: string; exit_code: number }>;
    };
  };
  snapshots: {
    create(sandboxId: string): Promise<PorterSnapshot>;
    delete(id: string): Promise<void>;
  };
  volumes: {
    create(body: { name?: string }): Promise<PorterVolumeLike>;
    get(name: string): Promise<PorterVolumeLike>;
    delete(name: string): Promise<void>;
    readFile(
      volumeId: string,
      path: string,
      range?: { offset: number; length: number },
    ): Promise<{ bytes: Uint8Array; size: number | null }>;
    writeFile(volumeId: string, path: string, bytes: Uint8Array): Promise<void>;
  };
}

export const withPorterErrorDetail = (e: unknown): unknown => {
  if (e instanceof SandboxError) {
    const detail = (e.body as { message?: string } | null)?.message;
    if (detail && !e.message.includes(detail)) e.message = `${e.message}: ${detail}`;
  }
  return e;
};

const detailed = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw withPorterErrorDetail(e);
  });

export function createPorterClient(opts: { token?: string; baseUrl?: string; timeoutMs?: number }): PorterClientLike {
  const porter = new Porter({
    ...(opts.token ? { apiKey: opts.token } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    timeoutMs: opts.timeoutMs ?? PORTER_CLIENT_TIMEOUT_MS,
  });
  const sandboxLike = (sb: PorterSdkSandbox): PorterSandboxLike => ({
    get id() {
      return sb.id;
    },
    get phase() {
      return sb.phase;
    },
    get tags() {
      return sb.tags;
    },
    refresh: () => detailed(sb.refresh()),
    terminate: () => detailed(sb.terminate()),
    logs: (options) => detailed(sb.logs(options)),
  });
  const volumeLike = (v: { id: string; attachedTo: string[] }): PorterVolumeLike => ({
    id: v.id,
    attachedTo: v.attachedTo,
  });
  return {
    sandboxes: {
      create: async (spec) => sandboxLike(await detailed(porter.sandboxes.create(spec))),
      get: async (name) => sandboxLike(await detailed(porter.sandboxes.get(name))),
      byId: async (id) =>
        sandboxLike(
          new PorterSdkSandbox({
            id,
            resource: porter.sandboxes.raw,
            status: await detailed(porter.sandboxes.raw.get(id)),
          }),
        ),
      listPage: async ({ tags, page }) => {
        const tag = tags ? Object.entries(tags).map(([k, v]) => `${k}=${v}`) : undefined;
        const r = await detailed(porter.sandboxes.raw.list({ tag, page }));
        return {
          sandboxes: r.sandboxes.map((status) =>
            sandboxLike(new PorterSdkSandbox({ id: status.id, resource: porter.sandboxes.raw, status })),
          ),
          hasNextPage: r.pagination.has_next_page,
        };
      },
      raw: {
        get: (id) => detailed(porter.sandboxes.raw.get(id)),
        exec: (id, body, options) => detailed(porter.sandboxes.raw.exec(id, body, options)),
      },
    },
    snapshots: {
      create: (sandboxId) => detailed(porter.snapshots.create(sandboxId, { mode: "filesystem" })),
      delete: (id) => detailed(porter.snapshots.delete(id)),
    },
    volumes: {
      create: async (body) => volumeLike(await detailed(porter.volumes.create(body))),
      get: async (name) => volumeLike(await detailed(porter.volumes.get(name))),
      delete: (name) => detailed(porter.volumes.delete(name)),
      readFile: async (volumeId, path, range) => {
        const content = await detailed(
          porter.volumes.raw.readFile(
            volumeId,
            { path, ...(range ? { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}) },
            { timeoutMs: PORTER_VOLUME_REQUEST_TIMEOUT_MS },
          ),
        );
        return { bytes: content.bytes, size: content.contentRange?.size ?? null };
      },
      writeFile: (volumeId, path, bytes) =>
        detailed(
          porter.volumes.raw.writeFile(volumeId, bytes, { path }, { timeoutMs: PORTER_VOLUME_REQUEST_TIMEOUT_MS }),
        ),
    },
  };
}

export const porterSlug = (prefix: string, id: string): string => {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${cleaned.slice(0, 28).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
};

export const porterDnsLabel = (name: string): string => {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned === name && cleaned.length <= 63) return cleaned;
  return `${cleaned.slice(0, 56).replace(/-+$/, "") || "app"}-${shortHash(name)}`;
};

export async function ensurePorterVolume(
  client: PorterClientLike,
  name: string,
): Promise<{ id: string; created: boolean; attachedTo: string[] }> {
  try {
    const found = await client.volumes.get(name);
    return { id: found.id, created: false, attachedTo: found.attachedTo };
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
    const made = await client.volumes.create({ name });
    return { id: made.id, created: true, attachedTo: made.attachedTo };
  }
}

export async function listPorterSandboxes(
  client: PorterClientLike,
  tags: Record<string, string>,
): Promise<PorterSandboxLike[]> {
  const all: PorterSandboxLike[] = [];
  for (let page = 1; ; page++) {
    const { sandboxes, hasNextPage } = await client.sandboxes.listPage({ tags, page });
    all.push(...sandboxes);
    if (!hasNextPage) return all;
  }
}

export async function porterSandboxById(client: PorterClientLike, id: string): Promise<PorterSandboxLike | null> {
  try {
    return await client.sandboxes.byId(id);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

const SETTLED_PHASES = new Set(["succeeded", "failed", "terminated"]);

export const porterPhaseSettled = (phase: string | null): boolean => SETTLED_PHASES.has(phase ?? "");

export async function retirePorterBody(sb: PorterSandboxLike, drain: boolean): Promise<void> {
  const gone = (e: unknown): boolean => e instanceof NotFoundError;
  if (porterPhaseSettled(sb.phase)) return;
  try {
    await sb.terminate();
  } catch (e) {
    if (gone(e)) return;
    throw e;
  }
  if (!drain) return;
  const deadline = Date.now() + RETIRE_DEADLINE_MS;
  while (!porterPhaseSettled(sb.phase)) {
    if (Date.now() > deadline)
      throw new Error(`porter sandbox ${sb.id} did not terminate within ${RETIRE_DEADLINE_MS}ms`);
    await sleep(RETIRE_POLL_MS);
    try {
      await sb.refresh();
    } catch (e) {
      if (gone(e)) return;
      throw e;
    }
  }
}

export async function waitPorterRunning(name: string, sb: PorterSandboxLike): Promise<void> {
  const deadline = Date.now() + CREATE_DEADLINE_MS;
  while (sb.phase !== "running") {
    if (porterPhaseSettled(sb.phase)) {
      throw new Error(`porter sandbox ${name} entered ${sb.phase} before running`);
    }
    if (Date.now() > deadline) throw new Error(`porter sandbox ${name} not running after ${CREATE_DEADLINE_MS}ms`);
    if (sb.phase !== null) await sleep(CREATE_POLL_MS);
    await sb.refresh();
  }
}

export interface PorterVolumeMount {
  volumeId: string;
  mountPath: string;
}

export const porterVolumeRelPath = (mount: PorterVolumeMount, absPath: string): string | null => {
  const root = mount.mountPath.replace(/\/+$/, "");
  if (absPath === root) return "/";
  return absPath.startsWith(`${root}/`) ? absPath.slice(root.length) : null;
};

export interface PorterExec {
  execRaw(id: string, script: string, timeoutSec: number): Promise<ExecResult>;
  writeAbsBytes(id: string, absPath: string, data: Uint8Array): Promise<void>;
  readAbsBytes(id: string, absPath: string): Promise<Uint8Array | null>;
}

export function createPorterExec(
  client: PorterClientLike,
  resolveId: (id: string) => Promise<string>,
  volumeFor: (id: string) => PorterVolumeMount | undefined = () => undefined,
): PorterExec {
  const filesApiDown = new Set<string>();

  const volumeTarget = (id: string, absPath: string): { volumeId: string; rel: string } | null => {
    const mount = volumeFor(id);
    if (!mount || filesApiDown.has(mount.volumeId)) return null;
    const rel = porterVolumeRelPath(mount, absPath);
    return rel ? { volumeId: mount.volumeId, rel } : null;
  };

  const fallBackToExec = (volumeId: string, what: string, e: unknown): void => {
    if (e instanceof SandboxError && e.statusCode !== null && e.statusCode < 500) filesApiDown.add(volumeId);
    swallow(`porter: volume file ${what} fell back to exec`, e);
  };

  async function execRaw(id: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const wrapped = `timeout -k 5 ${timeoutSec} sh -c ${shq(script)}`;
    const r = await client.sandboxes.raw.exec(
      await resolveId(id),
      { command: ["sh", "-c", wrapped] },
      { timeoutMs: timeoutSec * 1000 + EXIT_GRACE_MS },
    );
    return { stdout: r.stdout, stderr: r.stderr, code: r.exit_code, timedOut: r.exit_code === 124 };
  }

  async function writeAbsBytesViaExec(id: string, absPath: string, data: Uint8Array): Promise<void> {
    const part = `${absPath}.${randomUUID().slice(0, 8)}.part`;
    const b64 = Buffer.from(data).toString("base64");
    const mk = await execRaw(id, `mkdir -p "$(dirname ${shq(absPath)})" && : > ${shq(part)}`, 60);
    if (mk.code !== 0) throw new Error(`porter write ${absPath}: mkdir failed (${mk.code})`);
    try {
      for (let i = 0; i < b64.length; i += WRITE_CHUNK_B64) {
        const chunk = b64.slice(i, i + WRITE_CHUNK_B64);
        const r = await execRaw(id, `printf %s ${shq(chunk)} | base64 -d >> ${shq(part)}`, 120);
        if (r.code !== 0) throw new Error(`porter write ${absPath}: chunk ${i / WRITE_CHUNK_B64} failed (${r.code})`);
      }
      const fin = await execRaw(
        id,
        `sz=$(wc -c < ${shq(part)}) && mv -f ${shq(part)} ${shq(absPath)} && printf %s "$sz"`,
        60,
      );
      const written = Number.parseInt(fin.stdout.trim(), 10);
      if (fin.code !== 0 || written !== data.length) {
        throw new Error(`porter write ${absPath} failed (rc=${fin.code}, ${written}/${data.length} bytes)`);
      }
    } catch (e) {
      await execRaw(id, `rm -f ${shq(part)}`, 60).catch(swallowAs("porter: write part cleanup", undefined));
      throw e;
    }
  }

  async function writeAbsBytes(id: string, absPath: string, data: Uint8Array): Promise<void> {
    const target = volumeTarget(id, absPath);
    if (target) {
      try {
        await client.volumes.writeFile(target.volumeId, target.rel, data);
        return;
      } catch (e) {
        fallBackToExec(target.volumeId, `write ${absPath}`, e);
      }
    }
    await writeAbsBytesViaExec(id, absPath, data);
  }

  async function readAbsBytesViaExec(id: string, absPath: string): Promise<Uint8Array | null> {
    const script =
      `[ -e ${shq(absPath)} ] || exit ${MISSING_RC}; s=$(wc -c < ${shq(absPath)}); echo "$s"; ` +
      `if [ "$s" -le ${READ_CHUNK} ]; then base64 < ${shq(absPath)}; fi`;
    const r = await execRaw(id, script, 120);
    if (r.code === MISSING_RC) return null;
    if (r.code !== 0) throw new Error(`porter read ${absPath} failed (${r.code}): ${r.stderr.slice(0, 200)}`);
    const nl = r.stdout.indexOf("\n");
    const declared = Number.parseInt(r.stdout.slice(0, nl < 0 ? undefined : nl).trim(), 10);
    if (!Number.isFinite(declared)) throw new Error(`porter read ${absPath}: bad size (${r.stdout.slice(0, 40)})`);
    const parts: Buffer[] = [];
    if (declared <= READ_CHUNK) {
      parts.push(Buffer.from(r.stdout.slice(nl + 1).replace(/\s+/g, ""), "base64"));
    } else {
      for (let i = 0; i < Math.ceil(declared / READ_CHUNK); i++) {
        const chunk = `dd if=${shq(absPath)} bs=${READ_CHUNK} skip=${i} count=1 2>/dev/null | base64`;
        const c = await execRaw(id, chunk, 120);
        if (c.code !== 0) throw new Error(`porter read ${absPath} chunk ${i} failed (${c.code})`);
        parts.push(Buffer.from(c.stdout.replace(/\s+/g, ""), "base64"));
      }
    }
    const out = Buffer.concat(parts);
    if (out.length !== declared) throw new Error(`porter read ${absPath}: truncated (${out.length}/${declared})`);
    return out;
  }

  async function readVolumeFile(volumeId: string, rel: string): Promise<Uint8Array> {
    const first = await client.volumes.readFile(volumeId, rel, { offset: 0, length: PORTER_VOLUME_READ_CHUNK });
    if (first.size === null || first.size <= first.bytes.length) return first.bytes;
    const parts = [Buffer.from(first.bytes)];
    for (let offset = first.bytes.length; offset < first.size;) {
      const next = await client.volumes.readFile(volumeId, rel, { offset, length: PORTER_VOLUME_READ_CHUNK });
      if (next.bytes.length === 0) throw new Error(`porter read ${rel}: truncated (${offset}/${first.size})`);
      parts.push(Buffer.from(next.bytes));
      offset += next.bytes.length;
    }
    return Buffer.concat(parts);
  }

  async function readAbsBytes(id: string, absPath: string): Promise<Uint8Array | null> {
    const target = volumeTarget(id, absPath);
    if (target) {
      try {
        return await readVolumeFile(target.volumeId, target.rel);
      } catch (e) {
        if (e instanceof NotFoundError) return null;
        fallBackToExec(target.volumeId, `read ${absPath}`, e);
      }
    }
    return readAbsBytesViaExec(id, absPath);
  }

  return { execRaw, writeAbsBytes, readAbsBytes };
}
