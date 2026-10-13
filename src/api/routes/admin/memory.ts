import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope, requireScopedAdmin } from "../shared.ts";
import type { MemoryEdit } from "../../../memory/memory-service.ts";
import { renderFacts } from "../../../memory/facts.ts";
import { type ApiCtx } from "../route.ts";
import { discoverScopes } from "./common.ts";

export async function listMemoryScopes(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!deps.memory) return sendJson(res, 404, { error: "not_found" });
  audit(deps, { principalId: actor.id, action: "memory.scopes.read", resource: "memory", scopeLabel: scope });
  const labels = await discoverScopes(app, deps);
  const meta = (await deps.memory.metadata?.()) ?? null;
  const scopes = await Promise.all(
    [...labels].map(async ([id, label]) => {
      let bytes: number;
      let updatedAt: number | undefined;
      if (meta) {
        const m = meta.get(id);
        bytes = m?.bytes ?? 0;
        updatedAt = m?.updatedAt;
      } else {
        const content = await deps.memory!.read(id);
        bytes = Buffer.byteLength(content);
      }
      return {
        scopeId: id,
        ...(label ? { label } : {}),
        hasMemory: bytes > 0,
        bytes,
        ...(updatedAt ? { updatedAt } : {}),
      };
    }),
  );
  scopes.sort(
    (a, b) =>
      Number(b.hasMemory) - Number(a.hasMemory) ||
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      a.scopeId.localeCompare(b.scopeId),
  );
  return sendJson(res, 200, { scopeId: scope, scopes });
}

export async function adminMemory(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, method } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  const memory = deps.memory;
  if (!memory) return sendJson(res, 404, { error: "not_found" });
  const b = (isObj(body) ? body : {}) as { facts?: unknown; ids?: unknown };
  if (method === "PATCH") {
    const facts = Array.isArray(b.facts) ? b.facts : [];
    if (!facts.length || !facts.every((f) => isObj(f) && typeof f.id === "string" && typeof f.text === "string"))
      return sendJson(res, 400, { error: "bad_request", message: "memory edit requires { facts: [{ id, text }] }" });
    await memory.edit?.(scope, facts as MemoryEdit[], actor.id);
  } else if (method === "DELETE") {
    if (!Array.isArray(b.ids) || !b.ids.length || !b.ids.every((id) => typeof id === "string"))
      return sendJson(res, 400, { error: "bad_request", message: "memory delete requires { ids: string[] }" });
    await memory.delete?.(scope, b.ids as string[], actor.id);
  }
  const action = method === "GET" ? "memory.read" : "memory.update";
  audit(deps, { principalId: actor.id, action, resource: "memory", scopeLabel: scope });
  const facts = (await memory.facts?.(scope)) ?? [];
  return sendJson(res, 200, {
    scopeId: scope,
    content: memory.facts ? renderFacts(facts) : await memory.read(scope),
    facts: facts.map(({ id, text, createdAt, updatedAt }) => ({ id, text, createdAt, updatedAt })),
  });
}
