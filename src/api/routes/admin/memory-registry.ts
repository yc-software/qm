import {
  deleteBinding,
  deleteBrain,
  MemoryRegistryError,
  putBinding,
  putBrain,
  readRegistry,
  redactBrain,
  resolveMemoryRegistry,
  type MemoryRegistry,
  type MemoryRegistryStore,
  type RegistryChange,
} from "../../../memory/registry.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const ERRORS = { 400: "bad_request", 404: "not_found", 409: "conflict" } as const;

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
    brains: record.brains.map(redactBrain),
    bindings: record.bindings,
    disabled: resolveMemoryRegistry(record, registry).disabled,
    overlay: [...registry.overlayIds],
  };
}

async function change(
  ctx: ApiCtx,
  action: string,
  apply: (record: MemoryRegistry, change: RegistryChange) => MemoryRegistry,
): Promise<void> {
  const authorized = await registryAdmin(ctx);
  if (!authorized) return;
  const { actor, registry } = authorized;
  const id = ctx.params.id ?? "";
  try {
    const record = await registry.update((current) =>
      apply(current, { actor: actor.id, now: Date.now(), overlayIds: registry.overlayIds, key: registry.key }),
    );
    audit(ctx.deps, { principalId: actor.id, action, resource: id, scopeLabel: orgScope(ctx.deps) });
    return sendJson(ctx.res, 200, { ok: true, ...view(record, registry) });
  } catch (error) {
    if (!(error instanceof MemoryRegistryError)) throw error;
    return sendJson(ctx.res, error.status, { error: ERRORS[error.status], message: error.message });
  }
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
  const full = view(readRegistry((await registry.current()).record), registry);
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

export const putMemoryBrain = (ctx: ApiCtx) =>
  ctx.capability && (ctx.body as { clientSecret?: unknown }).clientSecret !== undefined
    ? sendJson(ctx.res, 400, {
        error: "bad_request",
        message:
          "a brain's client secret never goes through the agent: register the brain without clientSecret, then set it through the admin API outside chat",
      })
    : change(ctx, "memory-registry.brain.update", (record, c) => putBrain(record, ctx.params.id ?? "", ctx.body, c));

export const deleteMemoryBrain = (ctx: ApiCtx) =>
  change(ctx, "memory-registry.brain.delete", (record) => deleteBrain(record, ctx.params.id ?? ""));

export const putMemoryBinding = (ctx: ApiCtx) =>
  change(ctx, "memory-registry.binding.update", (record, c) => putBinding(record, ctx.params.id ?? "", ctx.body, c));

export const deleteMemoryBinding = (ctx: ApiCtx) =>
  change(ctx, "memory-registry.binding.delete", (record) => deleteBinding(record, ctx.params.id ?? ""));
