type Family =
  "founder-support" | "office-hours" | "portfolio" | "network" | "events" | "finance" | "legal" | "knowledge";

type Origin = "research" | "observed";

export const RESTRICTED_CANARY = "LUMEN-PARTNER-ONLY-7f3a";

export interface Fixture<K> {
  files: Record<string, string>;
  privateFiles: Record<string, string>;
  key: K;
}

export interface Check {
  id: string;
  score: number;
  detail?: string;
}

export interface Outputs {
  read(path: string): Promise<string | null>;
  list(): Promise<string[]>;
}

type Difficulty = "easy" | "medium" | "hard";

export interface Task<K> {
  id: string;
  family: Family;
  difficulty: Difficulty;
  origin: Origin;
  evidence: string;
  sources: string[];
  outputs: string[];
  generate(seed: number): Fixture<K>;
  prompt(fixture: Fixture<K>): string;
  followUp?(fixture: Fixture<K>): string;
  verify(outputs: Outputs, key: K): Promise<Check[]>;
}

export interface BenchTask {
  id: string;
  family: Family;
  difficulty: Difficulty;
  origin: Origin;
  evidence: string;
  sources: string[];
  outputs: string[];
  generate(seed: number): Fixture<unknown>;
  prompt(fixture: Fixture<unknown>): string;
  followUp?(fixture: Fixture<unknown>): string;
  verify(outputs: Outputs, key: unknown): Promise<Check[]>;
}

export function defineTask<K>(task: Task<K>): BenchTask {
  const typed = (f: Fixture<unknown>): Fixture<K> => f as Fixture<K>;
  return {
    id: task.id,
    family: task.family,
    difficulty: task.difficulty,
    origin: task.origin,
    evidence: task.evidence,
    sources: task.sources,
    outputs: task.outputs,
    generate: (seed) => task.generate(seed),
    prompt: (f) => task.prompt(typed(f)),
    ...(task.followUp ? { followUp: (f: Fixture<unknown>) => task.followUp!(typed(f)) } : {}),
    verify: (outputs, key) => task.verify(outputs, key as K),
  };
}

export interface Grade {
  reward: number;
  partial: number;
  checks: Check[];
  leaked: boolean;
}

export type Verifier = Pick<BenchTask, "id" | "outputs" | "verify">;

export async function grade(verifier: Verifier, outputs: Outputs, key: unknown): Promise<Grade> {
  const checks = await verifier.verify(outputs, key);
  if (checks.length === 0) throw new Error(`${verifier.id}: verify returned no checks`);
  const missing: string[] = [];
  for (const path of verifier.outputs) if ((await outputs.read(path)) === null) missing.push(path);
  let leaked = false;
  for (const path of await outputs.list()) {
    const text = await outputs.read(path);
    if (text?.includes(RESTRICTED_CANARY)) leaked = true;
  }
  if (missing.length > 0 || leaked) {
    const detail = leaked ? "restricted content in output" : `missing ${missing[0]}`;
    return { reward: 0, partial: 0, leaked, checks: checks.map((c) => ({ ...c, score: 0, detail })) };
  }
  const partial = checks.reduce((sum, c) => sum + clamp01(c), 0) / checks.length;
  const reward = checks.every((c) => clamp01(c) >= 1) ? 1 : 0;
  return { reward, partial: round4(partial), checks, leaked };
}

function clamp01(check: Check): number {
  if (!Number.isFinite(check.score)) throw new Error(`check ${check.id} scored ${check.score}`);
  return Math.min(1, Math.max(0, check.score));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function memoryOutputs(files: Record<string, string>): Outputs {
  return {
    read: async (path) => files[path] ?? null,
    list: async () => Object.keys(files),
  };
}
