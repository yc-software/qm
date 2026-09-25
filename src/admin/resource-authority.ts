import { AsyncLocalStorage } from "node:async_hooks";
import type { AdminService } from "./admin-service.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { CONTROL_PLANE_AUD, type CapabilityClaims } from "../auth/capability-token.ts";
import { livePersonCapability } from "../api/artifact-share.ts";
import { samePerson } from "../directory/person.ts";

export interface ResourceAuthorityDeps {
  admin?: Pick<AdminService, "adminStatusOf">;
  identity?: Pick<IdentityService, "refresh" | "classify">;
  config?: Pick<ScopedConfigStore, "resolveSharingPostureDurable">;
  auditLog?: AuditLog;
}

const authority = new AsyncLocalStorage<
  | {
      active: boolean;
      claims: CapabilityClaims;
      deps: ResourceAuthorityDeps;
      operation: string;
      audited: boolean;
    }
  | undefined
>();

export async function withResourceAuthority<T>(
  deps: ResourceAuthorityDeps,
  claims: CapabilityClaims | null | undefined,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!claims) return authority.run(undefined, run);
  const context = { active: true, claims, deps, operation, audited: false };
  return authority.run(context, async () => {
    try {
      return await run();
    } finally {
      context.active = false;
    }
  });
}

export async function isLiveResourceAdmin(actorId: string): Promise<boolean> {
  const context = authority.getStore();
  if (!context?.active) return false;
  const { claims, deps } = context;
  if (
    !samePerson(actorId, claims.actorId) ||
    claims.aud !== CONTROL_PLANE_AUD ||
    !livePersonCapability(claims) ||
    claims.triggered ||
    claims.botActor ||
    claims.deployment ||
    claims.exp <= Date.now() ||
    !deps.identity ||
    !deps.admin
  )
    return false;
  await deps.identity.refresh(true);
  const actor = deps.identity.classify(claims.actorId);
  if (actor.type !== "internal" || !(await deps.admin.adminStatusOf(actor)).isAdmin) return false;
  if (
    claims.scopeId !== `personal:${actor.id}` &&
    (await deps.config?.resolveSharingPostureDurable(`personal:${actor.id}`, claims.scopeId)) !== "open"
  )
    return false;
  if (!context.active) return false;
  if (!context.audited) {
    deps.auditLog?.record({
      at: Date.now(),
      principalId: actor.id,
      action: "admin_resource_access",
      resource: context.operation,
      scopeLabel: claims.scopeId,
    });
    context.audited = true;
  }
  return true;
}

export function resourceAdminActor(): string | undefined {
  const context = authority.getStore();
  return context?.active && context.audited ? context.claims.actorId : undefined;
}
