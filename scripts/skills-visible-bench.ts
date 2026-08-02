import { performance } from "node:perf_hooks";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { createSkillStore, type Skill, type SkillResolution } from "../src/skills/skill-store.ts";
import { isSafeSkillName } from "../src/skills/skill-name.ts";
import type { ScopeId } from "../src/types.ts";

class LimitedCountingMap<T> implements DurableMap<T> {
  allCalls = 0;
  private activeAll = 0;
  private readonly queue: Array<() => void> = [];
  private readonly m = new Map<string, T>();
  private readonly opts: { allLatencyMs: number; allConcurrency: number };

  constructor(opts: { allLatencyMs: number; allConcurrency: number }) {
    this.opts = opts;
  }

  resetCounts(): void {
    this.allCalls = 0;
  }

  private async withAllSlot<R>(fn: () => Promise<R>): Promise<R> {
    if (this.activeAll >= this.opts.allConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.activeAll += 1;
    try {
      return await fn();
    } finally {
      this.activeAll -= 1;
      this.queue.shift()?.();
    }
  }

  async all(): Promise<T[]> {
    this.allCalls += 1;
    return this.withAllSlot(async () => {
      if (this.opts.allLatencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.opts.allLatencyMs));
      }
      return [...this.m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
    });
  }

  async entries(): Promise<Array<[string, T]>> {
    return [...this.m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  async get(id: string): Promise<T | null> {
    return this.m.get(id) ?? null;
  }

  async put(id: string, value: T): Promise<void> {
    this.m.set(id, value);
  }

  async putIfAbsent(id: string, value: T): Promise<T> {
    const existing = this.m.get(id);
    if (existing !== undefined) return existing;
    this.m.set(id, value);
    return value;
  }

  async insertIfAbsent(id: string, value: T): Promise<boolean> {
    if (this.m.has(id)) return false;
    this.m.set(id, value);
    return true;
  }

  async merge(id: string, patch: Partial<T>): Promise<T | null> {
    const current = this.m.get(id);
    if (!current) return null;
    const next = { ...current, ...patch } as T;
    this.m.set(id, next);
    return next;
  }

  async delete(id: string): Promise<void> {
    this.m.delete(id);
  }

  async take(id: string): Promise<T | null> {
    const current = this.m.get(id) ?? null;
    this.m.delete(id);
    return current;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function skill(id: string, name: string, scopeId: ScopeId): Skill {
  return {
    id,
    scopeId,
    manifest: { name, description: `Skill ${name}`, requiredCapabilities: [], body: "body" },
    signature: "bench-signature",
    status: "published",
    createdBy: "bench",
    version: 1,
    grantedCapabilities: [],
    approvals: [],
  };
}

async function legacyResolve(
  backing: DurableMap<Skill>,
  name: string,
  orderedScopes: ScopeId[],
): Promise<SkillResolution> {
  if (!isSafeSkillName(name)) return { skill: null, shadowed: [] };
  const all = await backing.all();
  const published = orderedScopes
    .map((sc) => all.find((s) => s.status === "published" && s.manifest.name === name && s.scopeId === sc))
    .filter((s): s is Skill => Boolean(s));
  const [winner, ...shadowed] = published;
  return { skill: winner ?? null, shadowed };
}

async function legacyVisibleFor(backing: DurableMap<Skill>, orderedScopes: ScopeId[]): Promise<SkillResolution[]> {
  const inScope = new Set(orderedScopes);
  const names = [
    ...new Set(
      (await backing.all())
        .filter((s) => s.status === "published" && inScope.has(s.scopeId) && isSafeSkillName(s.manifest.name))
        .map((s) => s.manifest.name),
    ),
  ];
  const resolved = await Promise.all(names.map((n) => legacyResolve(backing, n, orderedScopes)));
  return resolved.filter((r): r is SkillResolution & { skill: Skill } => r.skill !== null);
}

async function measure(
  label: string,
  backing: LimitedCountingMap<Skill>,
  fn: () => Promise<SkillResolution[]>,
): Promise<{
  label: string;
  ms: number;
  allCalls: number;
  visible: number;
}> {
  backing.resetCounts();
  const start = performance.now();
  const visible = await fn();
  return { label, ms: performance.now() - start, allCalls: backing.allCalls, visible: visible.length };
}

const names = envInt("SKILLS_BENCH_NAMES", 200);
const scopesPerName = envInt("SKILLS_BENCH_SCOPES", 2);
const allLatencyMs = envInt("SKILLS_BENCH_ALL_LATENCY_MS", 2);
const allConcurrency = envInt("SKILLS_BENCH_ALL_CONCURRENCY", 8);

const backing = new LimitedCountingMap<Skill>({ allLatencyMs, allConcurrency });
const store = createSkillStore({ signingSecret: "bench-secret", backing });
const orderedScopes = Array.from(
  { length: scopesPerName },
  (_, i) => (i === 0 ? "personal:U1" : i === 1 ? "org:default-org" : `team:T${i}`) as ScopeId,
);

for (let i = 0; i < names; i += 1) {
  const name = `bench-skill-${String(i).padStart(4, "0")}`;
  for (let s = 0; s < orderedScopes.length; s += 1) {
    const id = `${s}-${i}`;
    await backing.put(id, skill(id, name, orderedScopes[s]!));
  }
}

const legacy = await measure("legacy visibleFor", backing, () => legacyVisibleFor(backing, orderedScopes));
const optimized = await measure("optimized visibleFor", backing, () => store.visibleFor(orderedScopes));

const speedup = legacy.ms / Math.max(optimized.ms, 0.001);
const readReduction = legacy.allCalls / Math.max(optimized.allCalls, 1);

console.log("Skills visibleFor benchmark");
console.log(
  JSON.stringify(
    {
      names,
      records: names * scopesPerName,
      scopesPerName,
      simulatedAllLatencyMs: allLatencyMs,
      simulatedAllConcurrency: allConcurrency,
    },
    null,
    2,
  ),
);
for (const row of [legacy, optimized]) {
  console.log(`${row.label}: ${row.ms.toFixed(1)}ms, all() calls=${row.allCalls}, visible=${row.visible}`);
}
console.log(
  `improvement: ${readReduction.toFixed(1)}x fewer full reads, ${speedup.toFixed(1)}x faster in this fixture`,
);
