import type { DurableMap } from "../persistence/durable-map.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { parseScopeId, type ScopeId, type ScopeKind } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { parseMemoryProviderConfig, type MemoryProviderConfig } from "./provider-config.ts";
import type { MemoryCapturePolicy, MemoryProviderRoute } from "./provider-router.ts";

export const MEMORY_REGISTRY_TABLE = "memory_registry";
const RECORD_ID = "org";
const MAX_BINDINGS = 2_000;
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCOPE_KINDS: readonly string[] = ["personal", "channel", "team", "org", "group"];

const BRAIN_PRESETS = {
  "gbrain-v1": {
    scopeRecall: false,
    read: { tool: "memory_recall", queryArg: "query", maxCharsArg: "max_chars" },
    write: { tool: "memory_write", factsArg: "facts", idempotencyArg: "idempotency_key" },
  },
} as const;

interface RegistryPoolSource {
  source: string;
  kinds: ScopeKind[];
}

export interface RegistryBrain {
  id: string;
  kind: "scopes" | "personal";
  preset: string;
  url: string;
  endpoint: string;
  auth: { clientId: string; clientSecret?: string };
  attestActor: boolean;
  timeoutMs: number;
  owner: ScopeId;
  label: string;
  pool: RegistryPoolSource[];
  enabled: boolean;
  updatedAt: number;
  updatedBy: string;
}

interface RegistryBinding {
  id: string;
  brain: string;
  endpoint: string;
  source?: string;
  scope: ScopeId | ScopeKind;
  state: "bound" | "released";
  capture: Exclude<MemoryCapturePolicy, "automatic">;
  recall: boolean;
  failOpen: boolean;
  label: string;
  updatedAt: number;
  updatedBy: string;
}

export interface MemoryRegistry {
  schema: 1;
  memberBrains: boolean;
  brains: RegistryBrain[];
  bindings: RegistryBinding[];
}

export const EMPTY_MEMORY_REGISTRY: MemoryRegistry = { schema: 1, memberBrains: true, brains: [], bindings: [] };

type RegistryDisabledCode =
  "brain_off" | "secret_missing" | "preset_unknown" | "id_taken" | "scope_recall_unsupported" | "invalid_config";

export interface DisabledRegistryRoute extends Pick<MemoryProviderRoute, "provider" | "scopes" | "recall" | "capture"> {
  binding: string;
  code: RegistryDisabledCode;
}

export class MemoryRegistryError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

const invalid = (message: string) => new MemoryRegistryError(400, message);
const conflict = (message: string) => new MemoryRegistryError(409, message);

function presetOf(brain: Pick<RegistryBrain, "preset">) {
  return Object.hasOwn(BRAIN_PRESETS, brain.preset)
    ? BRAIN_PRESETS[brain.preset as keyof typeof BRAIN_PRESETS]
    : undefined;
}

function brainEndpoint(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "") || "/mcp"}`.toLowerCase();
}

function brainConfig(brain: RegistryBrain, bindings: readonly RegistryBinding[], clientSecret: string) {
  const preset = presetOf(brain)!;
  const credentials = { clientIdEnv: "QM_BRAIN_CLIENT_ID", clientSecretEnv: "QM_BRAIN_CLIENT_SECRET" };
  return parseMemoryProviderConfig(
    JSON.stringify({
      providers: [
        {
          id: brain.id,
          type: "mcp",
          url: brain.url,
          timeoutMs: brain.timeoutMs,
          attestActor: brain.attestActor,
          read: { ...preset.read, ...credentials },
          write: { ...preset.write, ...credentials },
        },
      ],
      routes: bindings.map((binding) => ({
        provider: brain.id,
        scopes: [binding.scope],
        capture: binding.capture,
        recall: binding.recall,
        failOpen: binding.failOpen,
        label: binding.label,
      })),
    }),
    { QM_BRAIN_CLIENT_ID: brain.auth.clientId, QM_BRAIN_CLIENT_SECRET: clientSecret },
  )!;
}

function scopeFits(brain: RegistryBrain, binding: Pick<RegistryBinding, "scope" | "source">): boolean {
  const { scope, source } = binding;
  const parsed = parseScopeId(scope);
  const kind = SCOPE_KINDS.includes(scope) ? scope : parsed.ref && parsed.kind;
  if (!kind) return false;
  if (parseScopeId(brain.owner).kind !== "org" && scope !== brain.owner) return false;
  if (brain.kind === "personal") return kind === "personal" && source === undefined;
  return (
    kind !== "personal" &&
    scope !== kind &&
    brain.pool.some((entry) => entry.source === source && (entry.kinds as string[]).includes(kind))
  );
}

export function readRegistry(value: unknown): MemoryRegistry {
  if (value === null || value === undefined) return EMPTY_MEMORY_REGISTRY;
  const record = value as Partial<MemoryRegistry>;
  if (
    record.schema !== 1 ||
    typeof record.memberBrains !== "boolean" ||
    !Array.isArray(record.brains) ||
    !Array.isArray(record.bindings)
  )
    throw new Error("the memory registry record has a shape this QM build doesn't know");
  return record as MemoryRegistry;
}

function brainBlock(brain: RegistryBrain, overlayIds: ReadonlySet<string>): RegistryDisabledCode | undefined {
  if (!presetOf(brain)) return "preset_unknown";
  if (overlayIds.has(brain.id)) return "id_taken";
  if (!brain.enabled) return "brain_off";
  if (!brain.auth?.clientSecret) return "secret_missing";
  return undefined;
}

export function resolveMemoryRegistry(
  record: MemoryRegistry,
  overlayIds: ReadonlySet<string>,
): { config: MemoryProviderConfig; disabled: DisabledRegistryRoute[] } {
  const config: MemoryProviderConfig = { providers: [], routes: [] };
  const disabled: DisabledRegistryRoute[] = [];
  const brains = new Map(record.brains.map((brain) => [brain.id, brain]));
  const served = new Set<string>();
  for (const binding of record.bindings) {
    if (binding.state !== "bound") continue;
    const brain = brains.get(binding.brain);
    const disable = (code: RegistryDisabledCode) =>
      disabled.push({
        provider: binding.brain,
        binding: binding.id,
        scopes: [binding.scope],
        recall: binding.recall,
        capture: binding.capture,
        code,
      });
    if (!brain || brain.endpoint !== binding.endpoint || !scopeFits(brain, binding)) {
      disable("invalid_config");
      continue;
    }
    const code =
      brainBlock(brain, overlayIds) ??
      (brain.kind === "scopes" && !presetOf(brain)!.scopeRecall ? "scope_recall_unsupported" : undefined);
    if (code) {
      disable(code);
      continue;
    }
    try {
      const resolved = brainConfig(brain, [binding], brain.auth.clientSecret!);
      if (!served.has(brain.id)) config.providers.push(...resolved.providers);
      served.add(brain.id);
      config.routes.push(...resolved.routes);
    } catch {
      disable("invalid_config");
    }
  }
  return { config, disabled };
}

interface Change {
  actor: string;
  now: number;
  overlayIds: ReadonlySet<string>;
}

function object(value: unknown, at = "body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${at} must be a JSON object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw invalid(`${field} must be a non-empty string of at most ${max} characters`);
  return value.trim();
}

function flag(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw invalid(`${field} must be true or false`);
  return value;
}

function poolOf(value: unknown): RegistryPoolSource[] {
  if (!Array.isArray(value) || value.length > MAX_BINDINGS) throw invalid("pool must be an array of { source, kinds }");
  const seen = new Set<string>();
  return value.map((entry, i) => {
    const { source, kinds } = object(entry, `pool[${i}]`);
    if (typeof source !== "string" || !SOURCE.test(source) || seen.has(source))
      throw invalid(`pool[${i}].source must be a gbrain source id that appears once in the pool`);
    seen.add(source);
    if (
      !Array.isArray(kinds) ||
      !kinds.length ||
      kinds.some((kind) => kind === "personal" || typeof kind !== "string" || !SCOPE_KINDS.includes(kind))
    )
      throw invalid(`pool[${i}].kinds must list any of channel, team, org and group`);
    return { source, kinds: [...new Set(kinds as ScopeKind[])] };
  });
}

export function putBrain(
  record: MemoryRegistry,
  id: string,
  input: unknown,
  change: Change & { owner: ScopeId },
): MemoryRegistry {
  if (!ID.test(id) || id === "default")
    throw invalid(
      'brain id must be up to 63 lowercase letters, digits or hyphens, start with a letter, and not be "default"',
    );
  if (change.overlayIds.has(id)) throw conflict(`${id} comes from MEMORY_PROVIDER_CONFIG, which the API can't change`);
  const body = object(input);
  const existing = record.brains.find((brain) => brain.id === id);
  const bindings = record.bindings.filter((binding) => binding.brain === id);
  const kind = body.kind ?? existing?.kind;
  if (kind !== "scopes" && kind !== "personal") throw invalid('kind must be "scopes" or "personal"');
  const preset = body.preset ?? existing?.preset;
  if (typeof preset !== "string" || !presetOf({ preset }))
    throw invalid(`preset must be one of: ${Object.keys(BRAIN_PRESETS).join(", ")}`);
  const url = text(body.url ?? existing?.url, "url", 2048);
  let endpoint: string;
  try {
    endpoint = brainEndpoint(url);
  } catch {
    throw invalid("url must be a valid URL");
  }
  if (existing && bindings.length && (kind !== existing.kind || endpoint !== existing.endpoint))
    throw conflict(`brain ${id} has bindings, so its kind and address can't change; register a new brain instead`);
  const kept = url === existing?.url ? existing.auth.clientSecret : undefined;
  const clientSecret = body.clientSecret === undefined ? kept : text(body.clientSecret, "clientSecret", 4096);
  const attestActor = flag(body.attestActor, "attestActor", existing?.attestActor ?? true);
  if (kind === "personal" && !attestActor)
    throw invalid("a personal brain must attest the member: set attestActor to true");
  const timeoutMs = body.timeoutMs ?? existing?.timeoutMs ?? 3_000;
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 30_000)
    throw invalid("timeoutMs must be an integer from 1 to 30000");
  if (kind === "personal" && body.pool !== undefined && !(Array.isArray(body.pool) && !body.pool.length))
    throw invalid("only a scopes brain has a source pool");
  const pool = kind === "scopes" ? poolOf(body.pool ?? existing?.pool ?? []) : [];
  const orphan = bindings.find(
    (binding) => binding.state === "bound" && !pool.some((entry) => entry.source === binding.source),
  );
  if (kind === "scopes" && orphan)
    throw conflict(
      `binding ${orphan.id} uses source ${orphan.source}; release it before removing that source from the pool`,
    );
  const brain: RegistryBrain = {
    id,
    kind,
    preset,
    url,
    endpoint,
    auth: {
      clientId: text(body.clientId ?? existing?.auth.clientId, "clientId"),
      ...(clientSecret ? { clientSecret } : {}),
    },
    attestActor,
    timeoutMs: Number(timeoutMs),
    owner: existing?.owner ?? change.owner,
    label: text(body.label ?? existing?.label, "label", 80),
    pool,
    enabled: flag(body.enabled, "enabled", existing?.enabled ?? true),
    updatedAt: change.now,
    updatedBy: change.actor,
  };
  try {
    brainConfig(brain, [], clientSecret ?? "unset");
  } catch (error) {
    throw invalid(errMessage(error));
  }
  return {
    ...record,
    brains: existing ? record.brains.map((entry) => (entry.id === id ? brain : entry)) : [...record.brains, brain],
  };
}

export function deleteBrain(record: MemoryRegistry, id: string): MemoryRegistry {
  if (!record.brains.some((brain) => brain.id === id)) throw new MemoryRegistryError(404, `no brain ${id}`);
  const bound = record.bindings.find((binding) => binding.brain === id && binding.state === "bound");
  if (bound) throw conflict(`brain ${id} still serves binding ${bound.id}; release it first`);
  return { ...record, brains: record.brains.filter((brain) => brain.id !== id) };
}

export function putBinding(record: MemoryRegistry, id: string, input: unknown, change: Change): MemoryRegistry {
  if (!ID.test(id))
    throw invalid("binding id must be up to 63 lowercase letters, digits or hyphens, starting with a letter");
  const body = object(input);
  const existing = record.bindings.find((binding) => binding.id === id);
  const brainId = body.brain ?? existing?.brain;
  const brain = record.brains.find((entry) => entry.id === brainId);
  if (!brain) throw new MemoryRegistryError(404, `no brain ${String(brainId)}`);
  const scope = text(body.scope ?? existing?.scope, "scope");
  const source = body.source === undefined ? existing?.source : text(body.source, "source", 128);
  if (existing && (existing.brain !== brain.id || existing.scope !== scope || existing.source !== source))
    throw conflict(
      `binding ${id} binds ${existing.scope} to brain ${existing.brain}; its brain, source and scope can't change`,
    );
  if (existing && existing.endpoint !== brain.endpoint)
    throw conflict(`binding ${id} was claimed at ${existing.endpoint}, which isn't brain ${brain.id}'s address`);
  if (!scopeFits(brain, { scope, source }))
    throw invalid(
      brain.kind === "personal"
        ? `brain ${brain.id} is a personal brain: bind a personal scope${parseScopeId(brain.owner).kind === "org" ? " (or the kind personal)" : ` (${brain.owner})`} with no source`
        : `brain ${brain.id} is a scopes brain: bind an exact non-personal scope id to a pool source whose kinds include that scope's kind`,
    );
  const capture = body.capture ?? existing?.capture ?? "off";
  if (capture === "automatic")
    throw invalid('automatic capture into a brain isn\'t available yet; use "off" or "explicit"');
  if (capture !== "off" && capture !== "explicit") throw invalid('capture must be "off" or "explicit"');
  if (!existing) {
    if (record.bindings.length >= MAX_BINDINGS) throw conflict(`the registry holds at most ${MAX_BINDINGS} bindings`);
    const holder =
      source === undefined
        ? undefined
        : record.bindings.find((binding) => binding.endpoint === brain.endpoint && binding.source === source);
    if (holder)
      throw conflict(
        holder.scope === scope
          ? `source ${source} is reserved for ${scope} by binding ${holder.id}; bind that binding again instead`
          : `source ${source} at ${brain.endpoint} is already claimed by another scope`,
      );
  }
  const twin = record.bindings.find(
    (binding) =>
      binding.id !== id && binding.brain === brain.id && binding.scope === scope && binding.state === "bound",
  );
  if (twin) throw conflict(`${scope} is already bound to brain ${brain.id} by binding ${twin.id}`);
  const binding: RegistryBinding = {
    id,
    brain: brain.id,
    endpoint: brain.endpoint,
    ...(source === undefined ? {} : { source }),
    scope,
    state: "bound",
    capture,
    recall: flag(body.recall, "recall", existing?.recall ?? true),
    failOpen: flag(body.failOpen, "failOpen", existing?.failOpen ?? true),
    label: text(body.label ?? existing?.label ?? brain.label, "label", 80),
    updatedAt: change.now,
    updatedBy: change.actor,
  };
  return {
    ...record,
    bindings: existing
      ? record.bindings.map((entry) => (entry.id === id ? binding : entry))
      : [...record.bindings, binding],
  };
}

export function releaseBinding(record: MemoryRegistry, id: string, change: Omit<Change, "overlayIds">): MemoryRegistry {
  if (!record.bindings.some((binding) => binding.id === id)) throw new MemoryRegistryError(404, `no binding ${id}`);
  return {
    ...record,
    bindings: record.bindings.map((binding) =>
      binding.id === id ? { ...binding, state: "released", updatedAt: change.now, updatedBy: change.actor } : binding,
    ),
  };
}

export function redactBrain(brain: RegistryBrain) {
  const {
    auth: { clientSecret, ...auth },
    ...rest
  } = brain;
  return { ...rest, auth: { ...auth, hasClientSecret: !!clientSecret } };
}

export interface MemoryRegistryStore {
  readonly overlayIds: ReadonlySet<string>;
  current(): Promise<{ version: string; record: unknown }>;
  update(change: (record: MemoryRegistry) => MemoryRegistry): Promise<MemoryRegistry>;
}

export function createMemoryRegistryStore(opts: {
  map: DurableMap<MemoryRegistry>;
  pg: Pick<PgPool, "q">;
  overlay?: MemoryProviderConfig;
}): MemoryRegistryStore {
  let ready: Promise<unknown> | undefined;
  let cached: { version: string; record: unknown } | undefined;
  return {
    overlayIds: new Set(opts.overlay?.providers.map(({ id }) => id) ?? []),
    async current() {
      await (ready ??= opts.map.get(RECORD_ID).catch((error: unknown) => {
        ready = undefined;
        throw error;
      }));
      const rows = await opts.pg.q("SELECT v FROM durable_map_versions WHERE tbl = $1", [MEMORY_REGISTRY_TABLE]);
      const version = rows.length ? String(rows[0]!.v) : "0";
      if (cached?.version !== version) cached = { version, record: await opts.map.get(RECORD_ID) };
      return cached;
    },
    async update(change) {
      const [next] = await opts.map.mutateMany([{ id: RECORD_ID, apply: (current) => change(readRegistry(current)) }]);
      return next!;
    },
  };
}
