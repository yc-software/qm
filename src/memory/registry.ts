import { decryptSecret, encryptSecret, type SecretKey } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { parseScopeId, type ScopeId } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { parseMemoryProviderConfig, type MemoryProviderConfig } from "./provider-config.ts";
import type { MemoryCapturePolicy, MemoryProviderRoute } from "./provider-router.ts";

export const MEMORY_REGISTRY_TABLE = "memory_registry";
const RECORD_ID = "org";
const BINDING_ID = /^[a-z][a-z0-9-]{0,62}$/;

const BRAIN_PRESETS = {
  "gbrain-v1": {
    read: { tool: "memory_recall", queryArg: "query", maxCharsArg: "max_chars" },
    write: { tool: "memory_write", factsArg: "facts", idempotencyArg: "idempotency_key" },
  },
} as const;

export interface RegistryBrain {
  id: string;
  preset: string;
  url: string;
  auth: { clientId: string; clientSecretEnc?: string };
  timeoutMs?: number;
  label: string;
  updatedAt: number;
  updatedBy: string;
}

interface RegistryBinding {
  id: string;
  brain: string;
  scope: ScopeId;
  capture: Exclude<MemoryCapturePolicy, "automatic">;
  recall: boolean;
  failOpen: boolean;
  label: string;
  updatedAt: number;
  updatedBy: string;
}

export interface MemoryRegistry {
  schema: 1;
  brains: RegistryBrain[];
  bindings: RegistryBinding[];
}

export const EMPTY_MEMORY_REGISTRY: MemoryRegistry = { schema: 1, brains: [], bindings: [] };

type RegistryDisabledCode = "secret_missing" | "preset_unknown" | "id_taken" | "invalid_config";

export interface DisabledRegistryRoute extends Pick<MemoryProviderRoute, "provider" | "scopes" | "recall" | "capture"> {
  binding: string;
  code: RegistryDisabledCode;
  detail?: string;
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

function isPersonalScope(scope: string): boolean {
  const { kind, ref } = parseScopeId(scope);
  return scope === "personal" || (kind === "personal" && ref.length > 0);
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
          attestActor: true,
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

export function readRegistry(value: unknown): MemoryRegistry {
  if (value === null || value === undefined) return EMPTY_MEMORY_REGISTRY;
  const record = value as Partial<MemoryRegistry>;
  if (record.schema !== 1 || !Array.isArray(record.brains) || !Array.isArray(record.bindings))
    throw new Error("the memory registry record has a shape this QM build doesn't know");
  return record as MemoryRegistry;
}

function brainBlock(brain: RegistryBrain, overlayIds: ReadonlySet<string>): RegistryDisabledCode | undefined {
  if (!presetOf(brain)) return "preset_unknown";
  if (overlayIds.has(brain.id)) return "id_taken";
  if (!brain.auth.clientSecretEnc) return "secret_missing";
  return undefined;
}

export interface RegistryContext {
  overlayIds: ReadonlySet<string>;
  key: SecretKey;
}

export function resolveMemoryRegistry(
  record: MemoryRegistry,
  { overlayIds, key }: RegistryContext,
): { config: MemoryProviderConfig; disabled: DisabledRegistryRoute[] } {
  const config: MemoryProviderConfig = { providers: [], routes: [] };
  const disabled: DisabledRegistryRoute[] = [];
  const brains = new Map(record.brains.map((brain) => [brain.id, brain]));
  const served = new Set<string>();
  for (const binding of record.bindings) {
    const brain = brains.get(binding.brain);
    const disable = (code: RegistryDisabledCode, detail?: string) =>
      disabled.push({
        provider: binding.brain,
        binding: binding.id,
        scopes: [binding.scope],
        recall: binding.recall,
        capture: binding.capture,
        code,
        ...(detail ? { detail } : {}),
      });
    if (!brain) {
      disable("invalid_config", `brain ${binding.brain} isn't registered`);
      continue;
    }
    if (!isPersonalScope(binding.scope)) {
      disable("invalid_config", `${binding.scope} isn't a personal scope`);
      continue;
    }
    const code = brainBlock(brain, overlayIds);
    if (code) {
      disable(code);
      continue;
    }
    let clientSecret: string;
    try {
      clientSecret = decryptSecret(brain.auth.clientSecretEnc!, key);
    } catch (error) {
      disable(
        "invalid_config",
        `brain ${brain.id}'s client secret can't be decrypted with this instance's CONNECTOR_SECRET_KEY; set it again (${errMessage(error)})`,
      );
      continue;
    }
    try {
      const resolved = brainConfig(brain, [binding], clientSecret);
      if (!served.has(brain.id)) config.providers.push(...resolved.providers);
      served.add(brain.id);
      config.routes.push(...resolved.routes);
    } catch (error) {
      disable("invalid_config", errMessage(error));
    }
  }
  return { config, disabled };
}

export interface RegistryChange extends RegistryContext {
  actor: string;
  now: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("body must be a JSON object");
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

export function putBrain(record: MemoryRegistry, id: string, input: unknown, change: RegistryChange): MemoryRegistry {
  if (change.overlayIds.has(id)) throw conflict(`${id} comes from MEMORY_PROVIDER_CONFIG, which the API can't change`);
  const body = object(input);
  const existing = record.brains.find((brain) => brain.id === id);
  const preset = body.preset ?? existing?.preset;
  if (typeof preset !== "string" || !presetOf({ preset }))
    throw invalid(`preset must be one of: ${Object.keys(BRAIN_PRESETS).join(", ")}`);
  const url = text(body.url ?? existing?.url, "url", 2048);
  const clientSecret = body.clientSecret === undefined ? undefined : text(body.clientSecret, "clientSecret", 4096);
  const kept = url === existing?.url ? existing.auth.clientSecretEnc : undefined;
  const clientSecretEnc = clientSecret === undefined ? kept : encryptSecret(clientSecret, change.key);
  const timeoutMs = body.timeoutMs ?? existing?.timeoutMs;
  const brain: RegistryBrain = {
    id,
    preset,
    url,
    auth: {
      clientId: text(body.clientId ?? existing?.auth.clientId, "clientId"),
      ...(clientSecretEnc ? { clientSecretEnc } : {}),
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
    label: text(body.label ?? existing?.label, "label", 80),
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
  const bound = record.bindings.find((binding) => binding.brain === id);
  if (bound) throw conflict(`brain ${id} still serves binding ${bound.id}; delete it first`);
  return { ...record, brains: record.brains.filter((brain) => brain.id !== id) };
}

export function putBinding(record: MemoryRegistry, id: string, input: unknown, change: RegistryChange): MemoryRegistry {
  if (!BINDING_ID.test(id))
    throw invalid("binding id must be up to 63 lowercase letters, digits or hyphens, starting with a letter");
  const body = object(input);
  const existing = record.bindings.find((binding) => binding.id === id);
  const brainId = body.brain ?? existing?.brain;
  const brain = record.brains.find((entry) => entry.id === brainId);
  if (!brain) throw new MemoryRegistryError(404, `no brain ${String(brainId)}`);
  const scope = text(body.scope ?? existing?.scope, "scope");
  if (!isPersonalScope(scope))
    throw invalid(`brain ${brain.id} serves personal memory: bind the kind personal or one member's personal scope`);
  const capture = body.capture ?? existing?.capture ?? "off";
  if (capture === "automatic")
    throw invalid('automatic capture into a brain isn\'t available yet; use "off" or "explicit"');
  if (capture !== "off" && capture !== "explicit") throw invalid('capture must be "off" or "explicit"');
  const twin = record.bindings.find(
    (binding) => binding.id !== id && binding.brain === brain.id && binding.scope === scope,
  );
  if (twin) throw conflict(`${scope} is already bound to brain ${brain.id} by binding ${twin.id}`);
  const binding: RegistryBinding = {
    id,
    brain: brain.id,
    scope,
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

export function deleteBinding(record: MemoryRegistry, id: string): MemoryRegistry {
  if (!record.bindings.some((binding) => binding.id === id)) throw new MemoryRegistryError(404, `no binding ${id}`);
  return { ...record, bindings: record.bindings.filter((binding) => binding.id !== id) };
}

export function setBrainSecret(
  record: MemoryRegistry,
  target: Pick<RegistryBrain, "id" | "url">,
  clientSecret: string,
  change: RegistryChange,
): MemoryRegistry {
  const brain = record.brains.find((entry) => entry.id === target.id);
  if (!brain || brain.url !== target.url)
    throw conflict(
      `brain ${target.id} changed after this link was made, so the secret wasn't saved; ask for a fresh link`,
    );
  return putBrain(record, target.id, { clientSecret }, change);
}

export function redactBrain({ auth, ...rest }: RegistryBrain) {
  return { ...rest, auth: { clientId: auth.clientId, hasClientSecret: !!auth.clientSecretEnc } };
}

export interface MemoryRegistryStore extends RegistryContext {
  current(): Promise<{ version: string; record: unknown }>;
  update(change: (record: MemoryRegistry) => MemoryRegistry): Promise<MemoryRegistry>;
}

export function createMemoryRegistryStore(opts: {
  map: DurableMap<MemoryRegistry>;
  key: SecretKey;
  overlay?: MemoryProviderConfig;
}): MemoryRegistryStore {
  let cached: { version: string; record: unknown } | undefined;
  return {
    overlayIds: new Set(opts.overlay?.providers.map(({ id }) => id) ?? []),
    key: opts.key,
    async current() {
      const version = await opts.map.version();
      if (cached?.version !== version) cached = { version, record: await opts.map.get(RECORD_ID) };
      return cached;
    },
    async update(change) {
      const [next] = await opts.map.mutateMany([{ id: RECORD_ID, apply: (current) => change(readRegistry(current)) }]);
      return next!;
    },
  };
}
