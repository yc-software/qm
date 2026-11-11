import { canonicalPerson } from "../../directory/person.ts";
import { personAtKeyboard } from "../artifact-share.ts";
import {
  deleteMemberBrain,
  memberBrainId,
  memberBrainsOn,
  putMemberBrain,
  readRegistry,
  redactBrain,
  resolveMemoryRegistry,
  type MemoryRegistry,
  type MemoryRegistryStore,
  type RegistryChange,
} from "../../memory/registry.ts";
import { sendJson } from "../http.ts";
import { registryError, writeRegistry } from "./admin/memory-registry.ts";
import { parseScopeId, scopeId } from "../../types.ts";
import { tenantOf, type ApiCtx, type Route } from "./route.ts";
import { adminStanding, audit, orgScope } from "./shared.ts";

const NOT_LIVE = "a member's memory brain can only be managed on a turn that person sent";

const PRIVATE = "your memory brain's url and client id are private — ask the agent in a DM";

async function member(ctx: ApiCtx) {
  const { res, deps, capability } = ctx;
  if (!capability) {
    sendJson(res, 401, { error: "unauthorized", message: "agent capability token required" });
    return null;
  }
  if (!deps.memoryRegistry) {
    sendJson(res, 404, { error: "not_found" });
    return null;
  }
  if (!personAtKeyboard(capability)) {
    sendJson(res, 403, { error: "forbidden", message: NOT_LIVE });
    return null;
  }
  if (
    parseScopeId(capability.scopeId).kind !== "personal" &&
    (await deps.config?.resolveSharingPostureDurable(scopeId("personal", capability.actorId), capability.scopeId)) !==
      "open"
  ) {
    sendJson(res, 403, { error: "forbidden", message: PRIVATE });
    return null;
  }
  const owner = canonicalPerson(capability.actorId);
  if ((await adminStanding(deps, tenantOf(ctx), owner)) === "inactive") {
    sendJson(res, 403, { error: "forbidden", message: "this principal is no longer active" });
    return null;
  }
  return { owner, registry: deps.memoryRegistry };
}

function ownBrain(record: MemoryRegistry, registry: MemoryRegistryStore, owner: string) {
  const id = memberBrainId(owner);
  const brain = record.brains.find((entry) => entry.id === id && entry.owner === owner);
  const bindings = brain ? record.bindings.filter((binding) => binding.brain === id) : [];
  return {
    principalId: owner,
    memberBrains: memberBrainsOn(record),
    brain: brain ? redactBrain(brain) : null,
    binding: bindings[0] ?? null,
    disabled: brain ? resolveMemoryRegistry({ ...record, brains: [brain], bindings }, registry).disabled : [],
  };
}

async function getOwnBrain(ctx: ApiCtx): Promise<void> {
  const found = await member(ctx);
  if (!found) return;
  const { owner, registry } = found;
  audit(ctx, {
    principalId: owner,
    action: "memory-registry.member-brain.read",
    resource: memberBrainId(owner),
    scopeLabel: orgScope(ctx.deps),
  });
  let record: MemoryRegistry;
  try {
    record = readRegistry((await registry.current()).record);
  } catch (error) {
    return registryError(ctx, error);
  }
  return sendJson(ctx.res, 200, ownBrain(record, registry, owner));
}

async function changeOwnBrain(
  ctx: ApiCtx,
  action: string,
  apply: (record: MemoryRegistry, owner: string, change: RegistryChange) => MemoryRegistry,
): Promise<void> {
  const found = await member(ctx);
  if (!found) return;
  const { owner, registry } = found;
  return writeRegistry(ctx, {
    actor: owner,
    registry,
    action,
    resource: memberBrainId(owner),
    apply: (record, change) => apply(record, owner, change),
    show: (record) => ownBrain(record, registry, owner),
  });
}

export const memoryBrainRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/memory/brain", auth: "either", handle: getOwnBrain },
  {
    method: "PUT",
    path: "/v1/memory/brain",
    auth: "either",
    handle: (ctx) =>
      changeOwnBrain(ctx, "memory-registry.member-brain.update", (record, owner, change) =>
        putMemberBrain(record, owner, ctx.body, change),
      ),
  },
  {
    method: "DELETE",
    path: "/v1/memory/brain",
    auth: "either",
    handle: (ctx) =>
      changeOwnBrain(ctx, "memory-registry.member-brain.delete", (record, owner) => deleteMemberBrain(record, owner)),
  },
];
