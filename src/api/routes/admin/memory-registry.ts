import {
  AGENT_SECRET_REFUSAL,
  deleteBinding,
  deleteBrain,
  memberBrainsOn,
  MemoryRegistryError,
  putBinding,
  putBrain,
  readRegistry,
  redactBrain,
  REGISTRY_ERRORS,
  resolveMemoryRegistry,
  setMemberBrains,
  type MemoryRegistry,
  type MemoryRegistryStore,
  type RegistryChange,
} from "../../../memory/registry.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

async function registryAdmin(ctx: ApiCtx) {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return null;
  if (!ctx.deps.memoryRegistry) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return null;
  }
  return { actor, registry: ctx.deps.memoryRegistry };
}

function view(record: MemoryRegistry, registry: MemoryRegistryStore) {
  return {
    memberBrains: memberBrainsOn(record),
    brains: record.brains.map(redactBrain),
    bindings: record.bindings,
    disabled: resolveMemoryRegistry(record, registry).disabled,
    overlay: [...registry.overlayIds],
  };
}

export function registryError(ctx: ApiCtx, error: unknown): void {
  if (!(error instanceof MemoryRegistryError)) throw error;
  sendJson(ctx.res, error.status, { error: REGISTRY_ERRORS[error.status], message: error.message });
}

export async function writeRegistry(
  ctx: ApiCtx,
  write: {
    actor: string;
    registry: MemoryRegistryStore;
    action: string;
    resource: string;
    apply: (record: MemoryRegistry, change: RegistryChange) => MemoryRegistry;
    show: (record: MemoryRegistry) => object;
  },
): Promise<void> {
  const { actor, registry } = write;
  try {
    const record = await registry.update((current) =>
      write.apply(current, { actor, now: Date.now(), overlayIds: registry.overlayIds, key: registry.key }),
    );
    audit(ctx.deps, {
      principalId: actor,
      action: write.action,
      resource: write.resource,
      scopeLabel: orgScope(ctx.deps),
    });
    return sendJson(ctx.res, 200, { ok: true, ...write.show(record) });
  } catch (error) {
    return registryError(ctx, error);
  }
}

async function change(
  ctx: ApiCtx,
  action: string,
  apply: (record: MemoryRegistry, change: RegistryChange) => MemoryRegistry,
): Promise<void> {
  const authorized = await registryAdmin(ctx);
  if (!authorized) return;
  const { actor, registry } = authorized;
  return writeRegistry(ctx, {
    actor: actor.id,
    registry,
    action,
    resource: ctx.params.id ?? "memory-registry",
    apply,
    show: (record) => view(record, registry),
  });
}

async function read(ctx: ApiCtx, pick?: (full: ReturnType<typeof view>) => object | undefined): Promise<void> {
  const authorized = await registryAdmin(ctx);
  if (!authorized) return;
  const { actor, registry } = authorized;
  audit(ctx.deps, {
    principalId: actor.id,
    action: "memory-registry.read",
    resource: ctx.params.id ?? "memory-registry",
    scopeLabel: orgScope(ctx.deps),
  });
  let full: ReturnType<typeof view>;
  try {
    full = view(readRegistry((await registry.current()).record), registry);
  } catch (error) {
    return registryError(ctx, error);
  }
  const found = pick ? pick(full) : full;
  return found ? sendJson(ctx.res, 200, found) : sendJson(ctx.res, 404, { error: "not_found" });
}

export const getMemoryRegistry = (ctx: ApiCtx) => read(ctx);

export const getMemoryBrain = (ctx: ApiCtx) =>
  read(ctx, (full) => {
    const brain = full.brains.find(({ id }) => id === ctx.params.id);
    return brain && { ...brain, disabled: full.disabled.filter(({ provider }) => provider === brain.id) };
  });

export const getMemoryBinding = (ctx: ApiCtx) =>
  read(ctx, (full) => {
    const binding = full.bindings.find(({ id }) => id === ctx.params.id);
    return binding && { ...binding, disabled: full.disabled.filter((route) => route.binding === binding.id) };
  });

function putAgentBrain(record: MemoryRegistry, id: string, body: unknown, c: RegistryChange): MemoryRegistry {
  if ((body as { clientSecret?: unknown } | null)?.clientSecret !== undefined)
    throw new MemoryRegistryError(400, AGENT_SECRET_REFUSAL);
  const next = putBrain(record, id, body, c);
  const url = ({ brains }: MemoryRegistry) => brains.find((brain) => brain.id === id)?.url;
  if (url(record) !== undefined && url(next) !== url(record))
    throw new MemoryRegistryError(
      400,
      "a brain's url never changes through the agent: move it through the admin API outside chat",
    );
  return next;
}

export const putMemoryBrain = (ctx: ApiCtx) =>
  change(ctx, "memory-registry.brain.update", (record, c) =>
    (ctx.capability ? putAgentBrain : putBrain)(record, ctx.params.id ?? "", ctx.body, c),
  );

export const deleteMemoryBrain = (ctx: ApiCtx) =>
  change(ctx, "memory-registry.brain.delete", (record) => deleteBrain(record, ctx.params.id ?? ""));

export const putMemoryBinding = (ctx: ApiCtx) =>
  change(ctx, "memory-registry.binding.update", (record, c) => putBinding(record, ctx.params.id ?? "", ctx.body, c));

export const deleteMemoryBinding = (ctx: ApiCtx) =>
  change(ctx, "memory-registry.binding.delete", (record) => deleteBinding(record, ctx.params.id ?? ""));

export const putMemberBrains = (ctx: ApiCtx) =>
  change(ctx, "memory-registry.member-brains.update", (record) => setMemberBrains(record, ctx.body));
