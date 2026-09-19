import { PrincipalLinkError } from "../../../identity/principal-links.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";

const DIRECTORY_MEMBER_IS_CANONICAL =
  "that principal is a directory member; directory members stay canonical, so link the other identity to it instead";

export async function listPrincipalLinks(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.principalLinks) return sendJson(res, 404, { error: "not_found" });
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  return sendJson(res, 200, { links: await deps.principalLinks.list() });
}

export async function createPrincipalLink(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  if (!deps.principalLinks) return sendJson(res, 404, { error: "not_found" });
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const b = isObj(body) ? body : {};
  if (typeof b.principalId === "string" && deps.directory && (await deps.directory.get(b.principalId)))
    return sendJson(res, 400, { error: "link_failed", message: DIRECTORY_MEMBER_IS_CANONICAL });
  try {
    const link = await deps.principalLinks.link({
      principalId: b.principalId,
      canonicalId: b.canonicalId,
      evidence: b.evidence,
      linkedBy: actor.id,
    });
    await deps.identity?.refresh(true);
    audit(deps, {
      principalId: actor.id,
      action: "principal_link.create",
      resource: `${link.principalId} -> ${link.canonicalId}`,
      scopeLabel: orgScope(deps),
    });
    return sendJson(res, 200, { ok: true, link });
  } catch (error) {
    if (error instanceof PrincipalLinkError)
      return sendJson(res, error.status, { error: "link_failed", message: error.message });
    throw error;
  }
}

export async function deletePrincipalLink(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  if (!deps.principalLinks) return sendJson(res, 404, { error: "not_found" });
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const link = await deps.principalLinks.unlink(params.principalId!);
  if (!link) return sendJson(res, 404, { error: "not_found" });
  await deps.identity?.refresh(true);
  audit(deps, {
    principalId: actor.id,
    action: "principal_link.delete",
    resource: `${link.principalId} -> ${link.canonicalId}`,
    scopeLabel: orgScope(deps),
  });
  return sendJson(res, 200, { ok: true, link });
}
