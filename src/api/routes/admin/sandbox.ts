import { errMessage } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";

async function scopeBackgroundJobs(
  processes: ApiCtx["deps"]["processes"],
  scopeId: string,
  sandboxes: ReadonlyArray<{ id: string; ownerScopeId: string }>,
) {
  if (!processes) return [];
  const ownedIds = new Set(sandboxes.filter((s) => s.ownerScopeId === scopeId).map((s) => s.id));
  const [byScope, live] = await Promise.all([
    processes.listByScope(scopeId),
    ownedIds.size ? processes.listLive() : Promise.resolve([]),
  ]);
  const seen = new Map<string, (typeof byScope)[number]>();
  for (const r of [...byScope, ...live]) {
    if (r.kind !== "background") continue;
    if (r.scopeId !== scopeId && !(r.sandboxId && ownedIds.has(r.sandboxId))) continue;
    seen.set(r.processId, r);
  }
  return [...seen.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((r) => ({
      processId: r.processId,
      ...(r.sandboxId ? { sandboxId: r.sandboxId } : {}),
      scopeId: r.scopeId,
      command: r.command,
      ...(r.purpose ? { purpose: r.purpose } : {}),
      status: r.status,
      startedAt: r.startedAt,
      expiresAt: r.expiresAt,
    }));
}

export async function manageSandboxResources(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  const resources = ctx.deps.sandboxResources;
  if (!resources) return sendJson(ctx.res, 404, { error: "not_supported" });
  const scopeId = ctx.params.scopeId!;
  const input = (ctx.body ?? {}) as Record<string, unknown>;
  try {
    if (ctx.req.method === "GET") {
      const listing = await resources.list(actor.id, scopeId);
      const jobs = await scopeBackgroundJobs(ctx.deps.processes, scopeId, listing.sandboxes);
      return sendJson(ctx.res, 200, { ...listing, jobs });
    }
    if (input.action === "retire") {
      if (typeof input.sandboxId !== "string") throw new Error("retire requires sandboxId");
      const record = await resources.access(actor.id, input.sandboxId);
      if (record.ownerScopeId !== scopeId) throw new Error("sandbox belongs to another scope");
      await resources.retire(actor.id, input.sandboxId);
      audit(ctx, {
        principalId: actor.id,
        action: "sandbox.retire",
        resource: input.sandboxId,
        scopeLabel: scopeId,
      });
      return sendJson(ctx.res, 200, { retired: input.sandboxId });
    }
    if (input.action === "default") {
      if (input.sandboxId !== null && typeof input.sandboxId !== "string")
        throw new Error("sandboxId must be an ID or null");
      await resources.setDefault(actor.id, scopeId, input.sandboxId);
      audit(ctx, {
        principalId: actor.id,
        action: "sandbox.default",
        resource: String(input.sandboxId),
        scopeLabel: scopeId,
      });
      return sendJson(ctx.res, 200, { defaultSandboxId: input.sandboxId });
    }
    if (input.action !== "create" || typeof input.backend !== "string")
      throw new Error("choose create with backend, or default with sandboxId");
    const record = await resources.create(
      actor.id,
      scopeId,
      input.backend,
      typeof input.name === "string" ? input.name : undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    audit(ctx, { principalId: actor.id, action: "sandbox.create", resource: record.id, scopeLabel: scopeId });
    return sendJson(ctx.res, 201, record);
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "sandbox_request_failed", message: errMessage(error) });
  }
}
