import { IdentityLinkError } from "../../../identity/principals.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";

const MAX_EVIDENCE_LENGTH = 500;

async function admin(ctx: ApiCtx) {
  if (!ctx.deps.principals) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return null;
  }
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  return actor ? { actor, principals: ctx.deps.principals } : null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

async function guarded(ctx: ApiCtx, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    await ctx.deps.identity?.refresh(true);
  } catch (error) {
    if (error instanceof IdentityLinkError)
      return sendJson(ctx.res, error.status, { error: "link_failed", message: error.message });
    throw error;
  }
}

export async function listIdentities(ctx: ApiCtx): Promise<void> {
  const a = await admin(ctx);
  if (!a) return;
  const [principals, identities] = await Promise.all([a.principals.principals(), a.principals.identities()]);
  return sendJson(ctx.res, 200, { principals, identities });
}

/** Admin link: point an identity at a principal. Same function as the self-serve connect flow. */
export async function linkIdentity(ctx: ApiCtx): Promise<void> {
  const a = await admin(ctx);
  if (!a) return;
  const b = isObj(ctx.body) ? ctx.body : {};
  const handle = str(b.handle);
  const principalId = str(b.principalId);
  const evidence = str(b.evidence);
  if (!handle || !principalId) return sendJson(ctx.res, 400, { error: "handle and principalId are required" });
  if (!evidence || evidence.length > MAX_EVIDENCE_LENGTH)
    return sendJson(ctx.res, 400, { error: "evidence must say how the identity was verified as this person" });
  await guarded(ctx, async () => {
    const row = await a.principals.attach(handle, principalId, `admin:${a.actor.id}`, evidence);
    audit(ctx.deps, {
      principalId: a.actor.id,
      action: "identity.link",
      resource: `${row.provider}:${row.externalId} -> ${row.principalId}`,
      scopeLabel: orgScope(ctx.deps),
    });
    sendJson(ctx.res, 200, { ok: true, identity: row });
  });
}

export async function unlinkIdentity(ctx: ApiCtx): Promise<void> {
  const a = await admin(ctx);
  if (!a) return;
  const handle = str(isObj(ctx.body) ? ctx.body.handle : "");
  const row = handle ? await a.principals.unlink(handle) : null;
  if (!row) return sendJson(ctx.res, 404, { error: "not_found" });
  await ctx.deps.identity?.refresh(true);
  audit(ctx.deps, {
    principalId: a.actor.id,
    action: "identity.unlink",
    resource: `${row.provider}:${row.externalId}`,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true, identity: row });
}

/** Admin or deployment: replace the email identities this caller maintains for a principal. */
export async function setPrincipalEmails(ctx: ApiCtx): Promise<void> {
  const a = await admin(ctx);
  if (!a) return;
  const b = isObj(ctx.body) ? ctx.body : {};
  const emails = Array.isArray(b.emails) ? b.emails.filter((e): e is string => typeof e === "string") : null;
  if (!emails) return sendJson(ctx.res, 400, { error: "emails must be an array of addresses" });
  const linkedBy = str(b.source) ? `platform:${str(b.source)}` : `admin:${a.actor.id}`;
  const principalId = ctx.params.principalId!;
  await guarded(ctx, async () => {
    await a.principals.setEmails(principalId, emails, linkedBy);
    audit(ctx.deps, {
      principalId: a.actor.id,
      action: "identity.emails",
      resource: `${principalId} (${emails.length})`,
      scopeLabel: orgScope(ctx.deps),
    });
    sendJson(ctx.res, 200, { ok: true });
  });
}

export async function combinePrincipals(ctx: ApiCtx): Promise<void> {
  const a = await admin(ctx);
  if (!a) return;
  const b = isObj(ctx.body) ? ctx.body : {};
  const keep = str(b.keep);
  const drop = str(b.drop);
  if (!keep || !drop) return sendJson(ctx.res, 400, { error: "keep and drop are required" });
  await guarded(ctx, async () => {
    await a.principals.combine(keep, drop);
    audit(ctx.deps, {
      principalId: a.actor.id,
      action: "principal.combine",
      resource: `${drop} -> ${keep}`,
      scopeLabel: orgScope(ctx.deps),
    });
    sendJson(ctx.res, 200, { ok: true });
  });
}
