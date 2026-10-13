import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope, rejectNonObjectBody, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import { discoverScopes } from "./common.ts";
import { replaceAtReadRevision } from "../../../memory/memory-service.ts";

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
        updatedAt = content.length > 0 ? await deps.memory!.updatedAt?.(id) : undefined;
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

export async function getAdminMemory(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  if (!deps.memory) return sendJson(res, 404, { error: "not_found" });
  audit(deps, { principalId: actor.id, action: "memory.read", resource: "memory", scopeLabel: scope });
  const head = (await deps.memory.readHead?.(scope)) ?? { content: await deps.memory.read(scope), revision: "" };
  return sendJson(res, 200, { scopeId: scope, content: head.content, revision: head.revision });
}

export async function putAdminMemory(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  if (!deps.memory) return sendJson(res, 404, { error: "not_found" });
  if (rejectNonObjectBody(ctx)) return;
  const { content, revision } = body as { content?: unknown; revision?: unknown };
  if (typeof content !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "memory requires { content: string }" });
  if (typeof revision !== "string")
    return sendJson(res, 428, { error: "revision_required", message: "revision (from GET /v1/admin/memory) required" });
  if (!(await replaceAtReadRevision(deps.memory, scope, content, revision, actor.id)))
    return sendJson(res, 409, { error: "conflict", message: "Memory changed since it was read; GET it again." });
  audit(deps, { principalId: actor.id, action: "memory.update", resource: "memory", scopeLabel: scope });
  return sendJson(res, 200, {
    ok: true,
    scopeId: scope,
    revision: (await deps.memory.readHead?.(scope))?.revision ?? "",
  });
}
