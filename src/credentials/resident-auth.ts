import type { DurableMap } from "../persistence/durable-map.ts";
import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";

export interface ResidentAuthConnector {
  id: string;
  label: string;
  check: string;
  reauth: string;
}

export const RESIDENT_AUTH_CONNECTORS: readonly ResidentAuthConnector[] = [
  { id: "gh", label: "GitHub", check: "gh auth status", reauth: "gh auth login" },
  { id: "glab", label: "GitLab", check: "glab auth status", reauth: "glab auth login" },
  {
    id: "gcloud",
    label: "Google Cloud",
    check: "gcloud auth print-access-token",
    reauth: "gcloud auth login --no-launch-browser",
  },
];

export function mergeConnectors(
  base: readonly ResidentAuthConnector[],
  extra: readonly ResidentAuthConnector[],
): ResidentAuthConnector[] {
  const extraIds = new Set(extra.map((c) => c.id));
  return [...base.filter((c) => !extraIds.has(c.id)), ...extra];
}

type ResidentAuthState = "active" | "inactive" | "absent";

export interface ScopeLivenessRecord {
  scopeId: string;
  checkedAt: number;
  connectors: Record<string, ResidentAuthState>;
}

export interface LivenessCache {
  get(scopeId: string): Promise<ScopeLivenessRecord | null>;
  put(record: ScopeLivenessRecord): Promise<void>;
}

export function createLivenessCache(map: DurableMap<ScopeLivenessRecord>): LivenessCache {
  return {
    get: (scopeId) => map.get(scopeId),
    put: (record) => map.put(record.scopeId, record),
  };
}

const RESIDENT_AUTH_PROBE_TTL_MS = 5 * 60_000;

export function residentAuthProbeIsStale(
  record: ScopeLivenessRecord | null,
  now: number,
  ttlMs: number = RESIDENT_AUTH_PROBE_TTL_MS,
): boolean {
  if (!record) return true;
  return now - record.checkedAt > ttlMs;
}

export function buildResidentAuthProbeScript(
  connectors: readonly ResidentAuthConnector[],
  perCheckSec: number,
): string {
  const lines = connectors.map((c) => {
    const bin = c.check.split(/\s+/)[0];
    return (
      `( if command -v ${bin} >/dev/null 2>&1; then ` +
      `if timeout ${perCheckSec} ${c.check} >/dev/null 2>&1; then echo "${c.id}|active"; ` +
      `else echo "${c.id}|inactive"; fi; ` +
      `else echo "${c.id}|absent"; fi ) &`
    );
  });
  return `${lines.join("\n")}\nwait`;
}

function parseProbeOutput(stdout: string): Map<string, ResidentAuthState> {
  const out = new Map<string, ResidentAuthState>();
  for (const raw of stdout.split("\n")) {
    const [id, state] = raw.trim().split("|");
    if (id && (state === "active" || state === "inactive" || state === "absent")) {
      out.set(id, state);
    }
  }
  return out;
}

export interface ProbeResidentAuthOptions {
  sandbox: Sandbox;
  handle: SandboxHandle;
  cache: LivenessCache;
  scopeId: string;
  now: number;
  connectors?: readonly ResidentAuthConnector[];
  perCheckSec?: number;
  overallTimeoutMs?: number;
}

export async function probeResidentAuth(opts: ProbeResidentAuthOptions): Promise<void> {
  const connectors = opts.connectors ?? RESIDENT_AUTH_CONNECTORS;
  const script = buildResidentAuthProbeScript(connectors, opts.perCheckSec ?? 6);
  const res = await opts.sandbox.run(opts.handle, script, { timeoutMs: opts.overallTimeoutMs ?? 12_000 });
  const seen = parseProbeOutput(res.stdout);
  if (seen.size === 0) return;
  const prior = (await opts.cache.get(opts.scopeId))?.connectors ?? {};
  const connectorsOut: Record<string, ResidentAuthState> = { ...prior };
  for (const c of connectors) {
    const state = seen.get(c.id);
    if (state) connectorsOut[c.id] = state;
  }
  await opts.cache.put({ scopeId: opts.scopeId, checkedAt: opts.now, connectors: connectorsOut });
}
