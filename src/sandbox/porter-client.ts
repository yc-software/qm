import { randomUUID } from "node:crypto";
import { Porter, NotFoundError, SandboxError } from "porter-sandbox";
import { sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
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

export interface PorterSandboxLike {
  readonly id: string;
  readonly phase: string | null;
  readonly tags: Record<string, string> | null;
  refresh(): Promise<{ name: string; host?: string }>;
  terminate(): Promise<void>;
}

export interface PorterSandboxSpec {
  image: string;
  name?: string;
  command?: string[];
  tags?: Record<string, string>;
  env?: Record<string, string>;
  volume_mounts?: Record<string, string>;
  egress?: { allowed_destinations: string[] };
  networking?: Array<{ port: number; domains?: Array<{ domain?: string; visibility?: "public" | "private" }> }>;
  ttl_seconds?: number;
}

export interface PorterClientLike {
  sandboxes: {
    create(spec: PorterSandboxSpec): Promise<PorterSandboxLike>;
    get(name: string): Promise<PorterSandboxLike>;
    list(options?: { tags?: Record<string, string>; page?: number }): Promise<PorterSandboxLike[]>;
    raw: {
      get(id: string): Promise<{ phase: string; host?: string }>;
      exec(
        id: string,
        body: { command: string[] },
        options?: { timeoutMs?: number },
      ): Promise<{ stdout: string; stderr: string; exit_code: number }>;
    };
  };
  volumes: {
    create(body: { name?: string }): Promise<{ id: string }>;
    get(name: string): Promise<{ id: string }>;
    delete(name: string): Promise<void>;
  };
}

const enrichPorterError = (e: unknown): unknown => {
  if (e instanceof SandboxError) {
    const detail = (e.body as { message?: string } | null)?.message;
    if (detail && !e.message.includes(detail)) e.message = `${e.message}: ${detail}`;
  }
  return e;
};

export function withPorterErrorDetails<T>(value: T): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  return new Proxy(value as object, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return withPorterErrorDetails(v);
      return (...args: unknown[]) => {
        let out: unknown;
        try {
          out = v.apply(target, args);
        } catch (e) {
          throw enrichPorterError(e);
        }
        if (out instanceof Promise) {
          return out.then(
            (r) => withPorterErrorDetails(r),
            (e) => {
              throw enrichPorterError(e);
            },
          );
        }
        return withPorterErrorDetails(out);
      };
    },
  }) as T;
}

export function createPorterClient(opts: { token?: string; baseUrl?: string }): PorterClientLike {
  return withPorterErrorDetails(
    new Porter({
      ...(opts.token ? { apiKey: opts.token } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    }) as PorterClientLike,
  );
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
): Promise<{ id: string; created: boolean }> {
  try {
    return { id: (await client.volumes.get(name)).id, created: false };
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
    return { id: (await client.volumes.create({ name })).id, created: true };
  }
}

export async function listPorterSandboxes(
  client: PorterClientLike,
  tags: Record<string, string>,
): Promise<PorterSandboxLike[]> {
  const all: PorterSandboxLike[] = [];
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    const fresh = (await client.sandboxes.list({ tags, page })).filter((b) => !seen.has(b.id));
    if (fresh.length === 0) return all;
    for (const b of fresh) seen.add(b.id);
    all.push(...fresh);
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

export interface PorterExec {
  execRaw(id: string, script: string, timeoutSec: number): Promise<ExecResult>;
  writeAbsBytes(id: string, absPath: string, data: Uint8Array): Promise<void>;
  readAbsBytes(id: string, absPath: string): Promise<Uint8Array | null>;
}

export function createPorterExec(client: PorterClientLike, resolveId: (id: string) => Promise<string>): PorterExec {
  async function execRaw(id: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const wrapped = `timeout -k 5 ${timeoutSec} sh -c ${shq(script)}`;
    const r = await client.sandboxes.raw.exec(
      await resolveId(id),
      { command: ["sh", "-c", wrapped] },
      { timeoutMs: timeoutSec * 1000 + EXIT_GRACE_MS },
    );
    return { stdout: r.stdout, stderr: r.stderr, code: r.exit_code, timedOut: r.exit_code === 124 };
  }

  async function writeAbsBytes(id: string, absPath: string, data: Uint8Array): Promise<void> {
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

  async function readAbsBytes(id: string, absPath: string): Promise<Uint8Array | null> {
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

  return { execRaw, writeAbsBytes, readAbsBytes };
}
