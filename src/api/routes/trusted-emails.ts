import { createHash } from "node:crypto";
import { verifySignedPayload } from "../../auth/signed-token.ts";
import { canonicalPerson, foldPrincipalId, samePerson } from "../../directory/person.ts";
import { validEmail } from "../../identity/external-members.ts";
import { PrincipalLinkError } from "../../identity/principal-links.ts";
import { boundTenant } from "../../tenants/context.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { hasComposioAccounts } from "./composio.ts";
import type { ApiCtx, Route } from "./route.ts";
import { activePrincipal, audit, isObj, orgScope } from "./shared.ts";

const MAX_EMAILS = 20;

type EmailSkipReason =
  "inactive" | "external_member" | "linked_elsewhere" | "has_aliases" | "established" | "check_failed" | "link_refused";

interface EmailJoinResult {
  linked: number;
  unchanged: number;
  skipped: Partial<Record<EmailSkipReason, number>>;
}

function trustedPrincipalId(issuer: string, subject: string): string {
  return `oidc:${createHash("sha256").update(issuer).digest("hex")}:${Buffer.from(subject).toString("base64url")}`;
}

function verifiedEmailList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EMAILS) return null;
  const emails = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item !== item.trim().toLowerCase() || !validEmail(item)) return null;
    emails.add(item);
  }
  return [...emails];
}

/**
 * Links each provider-verified email identity to the signed-in person, in the bound tenant.
 * An email identity that already carries its own state (keychain credentials, Composio
 * connected accounts, links of its own) or belongs to someone else is left for an
 * administrator to merge. Nothing is moved; only a principal link is written.
 */
async function joinVerifiedEmails(
  ctx: ApiCtx,
  principalId: string,
  emails: readonly string[],
  evidence: string,
): Promise<EmailJoinResult> {
  const { deps } = ctx;
  const links = deps.principalLinks!;
  const result: EmailJoinResult = { linked: 0, unchanged: 0, skipped: {} };
  const skip = (reason: EmailSkipReason) => void (result.skipped[reason] = (result.skipped[reason] ?? 0) + 1);
  await links.refresh(true);
  await deps.identity?.refresh(true);
  const person = canonicalPerson(principalId);
  for (const email of emails) {
    if (samePerson(email, principalId)) {
      result.unchanged++;
      continue;
    }
    if (!(await activePrincipal(deps, email))) {
      skip("inactive");
      continue;
    }
    if (deps.identity?.externalMember(email)) {
      skip("external_member");
      continue;
    }
    if (canonicalPerson(email) !== email) {
      skip("linked_elsewhere");
      continue;
    }
    if (links.aliases(foldPrincipalId(email)).length) {
      skip("has_aliases");
      continue;
    }
    try {
      const credentials = (await deps.keychain?.listByOwner(email)) ?? [];
      if (credentials.length || (await hasComposioAccounts(ctx, email))) {
        skip("established");
        continue;
      }
    } catch (error) {
      console.warn(`[trusted-emails] could not inspect an email identity: ${errMessage(error)}`);
      skip("check_failed");
      continue;
    }
    try {
      await links.link({ principalId: email, canonicalId: person, evidence, linkedBy: principalId });
    } catch (error) {
      if (!(error instanceof PrincipalLinkError)) throw error;
      skip("link_refused");
      continue;
    }
    result.linked++;
    audit(deps, {
      principalId,
      action: "principal_link.create",
      resource: `${email} -> ${person}`,
      scopeLabel: orgScope(deps),
    });
  }
  if (result.linked) await deps.identity?.refresh(true);
  return result;
}

async function trustedEmails(ctx: ApiCtx): Promise<void> {
  const { deps, res, body } = ctx;
  if (!boundTenant()) {
    res.writeHead(204);
    return void res.end();
  }
  const secret = deps.portalIdentitySecret;
  if (!secret || secret.length < 32 || secret === ctx.secret || !deps.principalLinks || !deps.replayDedupe)
    return sendJson(res, 503, { error: "not_configured" });
  const assertion = isObj(body) && typeof body.assertion === "string" ? body.assertion : "";
  const claims = assertion.length <= 16_384 ? await verifySignedPayload(assertion, secret) : null;
  const now = Date.now();
  const emails = isObj(claims) ? verifiedEmailList(claims.emails) : null;
  if (
    !isObj(claims) ||
    claims.purpose !== "trusted-entry-emails" ||
    claims.org !== orgScope() ||
    typeof claims.issuer !== "string" ||
    !claims.issuer ||
    claims.issuer.length > 2048 ||
    typeof claims.subject !== "string" ||
    !claims.subject ||
    claims.subject.length > 255 ||
    claims.imp !== undefined ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    claims.exp > now + 60_000 ||
    typeof claims.jti !== "string" ||
    !/^[a-f0-9-]{36}$/.test(claims.jti) ||
    !emails
  )
    return sendJson(res, 403, { error: "invalid_assertion" });
  const principalId = trustedPrincipalId(claims.issuer, claims.subject);
  if (!(await activePrincipal(deps, principalId))) return sendJson(res, 403, { error: "inactive_principal" });
  if (!(await deps.replayDedupe.claim(`trusted-emails:${claims.jti}`, claims.exp)))
    return sendJson(res, 409, { error: "assertion_already_used" });
  const evidence = `Email verified by trusted OIDC issuer ${claims.issuer} for its subject at sign-in`.slice(0, 500);
  return sendJson(res, 200, await joinVerifiedEmails(ctx, principalId, emails, evidence));
}

export const trustedEmailRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/auth/trusted/emails",
    actor: "system",
    auth: "source",
    tenant: "optional",
    handle: trustedEmails,
  },
];
