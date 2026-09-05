import { MIN_PASSWORD_LENGTH, passwordProblem } from "../../../auth/password-credentials.ts";
import { personKey, samePerson } from "../../../directory/person.ts";
import { validEmailIdentifier } from "../../../auth/identifier.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";

const MAX_DISPLAY_NAME = 200;

/**
 * Administrator-managed accounts.
 *
 * These routes create a person and manage their password. They are an
 * authorization path: everything here is gated by an org admin grant, and
 * every write is audited. Nothing here returns a password or a hash.
 */

function storeOr404(ctx: ApiCtx): NonNullable<ApiCtx["deps"]["passwordCredentials"]> | null {
  const store = ctx.deps.passwordCredentials;
  if (!store) {
    sendJson(ctx.res, 404, {
      error: "not_found",
      message: "this deployment does not manage password accounts; set QM_PASSWORD_SIGN_IN to turn them on",
    });
    return null;
  }
  return store;
}

export async function listAccounts(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const store = storeOr404(ctx);
  if (!store) return;
  audit(deps, { principalId: actor.id, action: "accounts.read", resource: "accounts", scopeLabel: scope });

  await deps.identity?.refresh();
  const [credentials, members] = await Promise.all([store.list(), deps.directory?.list() ?? Promise.resolve([])]);
  const namesByKey = new Map(members.map((m) => [personKey(m.principalId), m.displayName]));
  const accounts = credentials
    .map((c) => ({
      principalId: c.principalId,
      displayName: namesByKey.get(personKey(c.principalId)) ?? c.principalId,
      mustChange: c.mustChange,
      updatedAt: c.updatedAt,
      updatedBy: c.updatedBy,
      active: (deps.identity?.classify(c.principalId).type ?? "internal") === "internal",
    }))
    .sort((a, b) => a.principalId.localeCompare(b.principalId));
  return sendJson(res, 200, { scopeId: scope, accounts, minPasswordLength: MIN_PASSWORD_LENGTH });
}

export async function createAccount(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const store = storeOr404(ctx);
  if (!store) return;
  if (!deps.directory) return sendJson(res, 503, { error: "not_configured", message: "no directory is configured" });

  const b = isObj(body) ? body : {};
  const principalId = typeof b.principalId === "string" ? b.principalId.trim() : "";
  const displayNameRaw = typeof b.displayName === "string" ? b.displayName.trim() : "";
  const password = typeof b.password === "string" ? b.password : "";
  if (!validEmailIdentifier(principalId)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "principalId must be an email address — it is the person key the rest of the system already uses",
    });
  }
  if (displayNameRaw.length > MAX_DISPLAY_NAME)
    return sendJson(res, 400, { error: "bad_request", message: "displayName is too long" });
  const problem = passwordProblem(password);
  if (problem) return sendJson(res, 400, { error: "weak_password", message: problem });

  if (await store.get(principalId))
    return sendJson(res, 409, { error: "exists", message: "that account already has a password" });

  const displayName = displayNameRaw || principalId;
  await deps.directory.upsertMember({ principalId, displayName, type: "internal" });
  await deps.identity?.reactivate(principalId);
  await store.set(principalId, password, actor.id, true);
  audit(deps, {
    principalId: actor.id,
    action: "account.create",
    resource: principalId,
    scopeLabel: scope,
    detail: "initial password set, change required at next sign-in",
  });
  return sendJson(res, 200, { ok: true, principalId, displayName, mustChange: true });
}

export async function resetAccountPassword(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, params } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const store = storeOr404(ctx);
  if (!store) return;
  const principalId = params.principalId!;
  const b = isObj(body) ? body : {};
  const password = typeof b.password === "string" ? b.password : "";
  const problem = passwordProblem(password);
  if (problem) return sendJson(res, 400, { error: "weak_password", message: problem });
  if (!(await store.get(principalId))) return sendJson(res, 404, { error: "not_found" });

  await store.set(principalId, password, actor.id, true);
  audit(deps, {
    principalId: actor.id,
    action: "account.password.reset",
    resource: principalId,
    scopeLabel: scope,
    detail: "change required at next sign-in",
  });
  return sendJson(res, 200, { ok: true, principalId, mustChange: true });
}

export async function setAccountActive(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, params } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const store = storeOr404(ctx);
  if (!store) return;
  const principalId = params.principalId!;
  const b = isObj(body) ? body : {};
  // An absent or non-boolean `active` is refused rather than read as false: the
  // destructive reading must not be what ambiguous input defaults to, even on
  // an admin-gated audited route.
  if (typeof b.active !== "boolean") {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "active must be true or false",
    });
  }
  const active = b.active;
  if (!active && samePerson(actor.id, principalId)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "an administrator cannot deactivate their own account",
    });
  }
  if (!(await store.get(principalId))) return sendJson(res, 404, { error: "not_found" });

  if (active) await deps.identity?.reactivate(principalId);
  else await deps.identity?.deactivate(principalId, "manual");
  audit(deps, {
    principalId: actor.id,
    action: active ? "account.reactivate" : "account.deactivate",
    resource: principalId,
    scopeLabel: scope,
  });
  return sendJson(res, 200, { ok: true, principalId, active });
}

export async function deleteAccount(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const store = storeOr404(ctx);
  if (!store) return;
  const principalId = params.principalId!;
  if (samePerson(actor.id, principalId))
    return sendJson(res, 400, { error: "bad_request", message: "an administrator cannot delete their own account" });
  if (!(await store.get(principalId))) return sendJson(res, 404, { error: "not_found" });

  // The credential goes; the person's history does not. Deactivation is what
  // stops an open session, so both happen.
  await store.remove(principalId);
  await deps.identity?.deactivate(principalId, "manual");
  audit(deps, { principalId: actor.id, action: "account.delete", resource: principalId, scopeLabel: scope });
  return sendJson(res, 200, { ok: true, principalId });
}
