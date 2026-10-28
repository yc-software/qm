import { PrincipalLinkError } from "../../../identity/principal-links.ts";
import { adminStatusFromGrants } from "../../../admin/admin-service.ts";
import { samePerson } from "../../../directory/person.ts";
import { isObj } from "../shared.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "../route.ts";
import { notFound, orgAdmin } from "./common.ts";

const DIRECTORY_MEMBER_IS_CANONICAL =
  "that principal is a directory member; directory members stay canonical, so link the other identity to it instead";
const ADMIN_SIGN_IN_NEEDS_ADMIN_CANONICAL =
  "that sign-in holds an org admin grant; a link may not make another principal an admin, so grant the canonical principal first or revoke it";

async function directoryMember(deps: ApiCtx["deps"], id: string): Promise<boolean> {
  if (!deps.directory) return false;
  const trimmed = id.trim();
  return (await deps.directory.list()).some((m) => samePerson(m.principalId, trimmed) || m.slackId === trimmed);
}

export async function listPrincipalLinks(ctx: ApiCtx): Promise<RouteResult> {
  const { deps } = ctx;
  if (!deps.principalLinks) throw notFound();
  await orgAdmin(ctx);
  return ok({ links: await deps.principalLinks.list() });
}

export async function createPrincipalLink(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body } = ctx;
  if (!deps.principalLinks) throw notFound();
  const authz = await orgAdmin(ctx);
  const b = isObj(body) ? body : {};
  if (typeof b.principalId === "string" && (await directoryMember(deps, b.principalId)))
    return reply(400, { error: "link_failed", message: DIRECTORY_MEMBER_IS_CANONICAL });
  if (typeof b.principalId === "string" && typeof b.canonicalId === "string" && deps.admin) {
    const grants = await deps.admin.listGrants();
    if (adminStatusFromGrants(grants, b.principalId).isAdmin && !adminStatusFromGrants(grants, b.canonicalId).isAdmin)
      return reply(400, { error: "link_failed", message: ADMIN_SIGN_IN_NEEDS_ADMIN_CANONICAL });
  }
  try {
    const link = await deps.principalLinks.link({
      principalId: b.principalId,
      canonicalId: b.canonicalId,
      linkedBy: authz.actor.id,
    });
    await deps.identity?.refresh(true);
    authz.audit("principal_link.create", `${link.principalId} -> ${link.canonicalId}`);
    return ok({ ok: true, link });
  } catch (error) {
    if (error instanceof PrincipalLinkError)
      return reply(error.status, { error: "link_failed", message: error.message });
    throw error;
  }
}

export async function deletePrincipalLink(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, params } = ctx;
  if (!deps.principalLinks) throw notFound();
  const authz = await orgAdmin(ctx);
  const link = await deps.principalLinks.unlink(params.principalId!);
  if (!link) throw notFound();
  await deps.identity?.refresh(true);
  authz.audit("principal_link.delete", `${link.principalId} -> ${link.canonicalId}`);
  return ok({ ok: true, link });
}
