import { canonicalPerson } from "../../directory/person.ts";
import {
  deleteMemberBrain,
  memberBrainId,
  putMemberBrain,
  readRegistry,
  redactBrain,
  resolveMemoryRegistry,
  type MemoryRegistry,
  type MemoryRegistryStore,
  type RegistryChange,
} from "../../memory/registry.ts";
import { sendJson } from "../http.ts";
import { writeRegistry } from "./admin/memory-registry.ts";
import type { ApiCtx, Route } from "./route.ts";
import { adminStanding, audit, orgScope } from "./shared.ts";

const TRIGGERED = "a memory brain can only be connected on a turn a person sent — this turn was fired by a trigger";

async function member(ctx: ApiCtx) {
  const { res, deps, capability, method } = ctx;
  if (!capability) {
    sendJson(res, 401, { error: "unauthorized", message: "agent capability token required" });
    return null;
  }
  if (!deps.memoryRegistry) {
    sendJson(res, 404, { error: "not_found" });
    return null;
  }
  if (method !== "GET" && capability.triggered) {
    sendJson(res, 403, { error: "forbidden", message: TRIGGERED });
    return null;
  }
  const owner = canonicalPerson(capability.actorId);
  if ((await adminStanding(deps, owner)) === "inactive") {
    sendJson(res, 403, { error: "forbidden", message: "this principal is no longer active" });
    return null;
  }
  return { owner, registry: deps.memoryRegistry };
}

function ownBrain(record: MemoryRegistry, registry: MemoryRegistryStore, owner: string) {
  const id = memberBrainId(owner);
  const brain = record.brains.find((entry) => entry.id === id && entry.owner === owner);
  return {
    principalId: owner,
    memberBrains: record.memberBrains !== false,
    brain: brain ? redactBrain(brain) : null,
    binding: (brain && record.bindings.find((binding) => binding.brain === id)) ?? null,
    disabled: brain ? resolveMemoryRegistry(record, registry).disabled.filter(({ provider }) => provider === id) : [],
  };
}

async function getOwnBrain(ctx: ApiCtx): Promise<void> {
  const found = await member(ctx);
  if (!found) return;
  const { owner, registry } = found;
  audit(ctx.deps, {
    principalId: owner,
    action: "memory-registry.member-brain.read",
    resource: memberBrainId(owner),
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, ownBrain(readRegistry((await registry.current()).record), registry, owner));
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
