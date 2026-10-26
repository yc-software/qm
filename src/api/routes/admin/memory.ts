import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, requireScopedAdmin } from "../shared.ts";
import { renderFacts } from "../../../memory/facts.ts";
import { memoryFacts, parseEdits, parseFacts, parseIds } from "../surface.ts";
import { type ApiCtx } from "../route.ts";
import { discoverScopes } from "./common.ts";
import { tenant } from "../../../tenant.ts";

export async function listMemoryScopes(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  const scope = tenant().orgScope;
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
  if (method === "POST") {
    const facts = parseFacts(body);
    if (typeof facts === "string") return sendJson(res, 400, { error: "bad_request", message: facts });
    await memory.capture(scope, facts, Date.now(), actor.id, { mode: "explicit" });
  } else if (method === "PATCH") {
    const edits = parseEdits(body);
    if (typeof edits === "string") return sendJson(res, 400, { error: "bad_request", message: edits });
    await memory.edit?.(scope, edits, actor.id);
  } else if (method === "DELETE") {
    const ids = parseIds(body);
    if (typeof ids === "string") return sendJson(res, 400, { error: "bad_request", message: ids });
    await memory.delete?.(scope, ids, actor.id);
  }
  const action = method === "GET" ? "memory.read" : "memory.update";
  audit(deps, { principalId: actor.id, action, resource: "memory", scopeLabel: scope });
  const facts = await memoryFacts(memory, scope);
  return sendJson(res, 200, {
    scopeId: scope,
    content: memory.facts ? renderFacts(facts) : await memory.read(scope),
    facts,
  });
}
