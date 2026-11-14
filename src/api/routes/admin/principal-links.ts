import { PrincipalLinkError } from "../../../identity/principal-links.ts";
import { adminStatusFromGrants } from "../../../admin/admin-service.ts";
import { samePerson } from "../../../directory/person.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";
import { tenantOf, type ApiCtx } from "../route.ts";

const DIRECTORY_MEMBER_IS_CANONICAL =
  "that principal is a directory member; directory members stay canonical, so link the other identity to it instead";
const ADMIN_SIGN_IN_NEEDS_ADMIN_CANONICAL =
  "that sign-in holds an org admin grant; a link may not make another principal an admin, so grant the canonical principal first or revoke it";
const APP_IS_NOT_A_PERSON = "that principal is a Slack bot or app, not a person, so it cannot be linked to one";

async function directoryMember(deps: ApiCtx["deps"], id: string): Promise<boolean> {
  if (!deps.directory) return false;
  const trimmed = id.trim();
  return (await deps.directory.list()).some((m) => samePerson(m.principalId, trimmed) || m.slackId === trimmed);
}

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
  if (typeof b.principalId === "string" && (await directoryMember(deps, b.principalId)))
    return sendJson(res, 400, { error: "link_failed", message: DIRECTORY_MEMBER_IS_CANONICAL });
  const named = [b.principalId, b.canonicalId].filter((id) => typeof id === "string");
  const users = await deps.admin?.users.resolve(named);
  if ([...(users?.values() ?? [])].some((user) => user.kind === "app"))
    return sendJson(res, 400, { error: "link_failed", message: APP_IS_NOT_A_PERSON });
  if (typeof b.principalId === "string" && typeof b.canonicalId === "string" && deps.admin) {
    const grants = await deps.admin.listGrants(tenantOf(ctx));
    if (adminStatusFromGrants(grants, b.principalId).isAdmin && !adminStatusFromGrants(grants, b.canonicalId).isAdmin)
      return sendJson(res, 400, { error: "link_failed", message: ADMIN_SIGN_IN_NEEDS_ADMIN_CANONICAL });
  }
  try {
    const link = await deps.principalLinks.link({
      principalId: b.principalId,
      canonicalId: b.canonicalId,
      evidence: b.evidence,
      linkedBy: actor.id,
    });
    await deps.identity?.refresh(true);
    audit(ctx, {
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
  audit(ctx, {
    principalId: actor.id,
    action: "principal_link.delete",
    resource: `${link.principalId} -> ${link.canonicalId}`,
    scopeLabel: orgScope(deps),
  });
  return sendJson(res, 200, { ok: true, link });
}
