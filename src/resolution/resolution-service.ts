import type { Conversation, Principal, Resolution, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";
import { composePolicy, defaultOrgPolicy } from "../policy/command-policy.ts";
import type { ScopedConfigStore } from "./config-store.ts";
import type { AclStore } from "../acl/acl-store.ts";
import { audienceEgressFloor, audienceDeniedFloor } from "./audience-floor.ts";
import { entitledScopes } from "./context-filter.ts";
import { resolveSecurityPolicy, type SecurityScreenMode } from "../security/security-posture.ts";
import type { Tenant } from "../tenants/context.ts";

export interface ResolutionService {
  scopeFor(conversation: Conversation, actor: Principal): ScopeId;
  resolve(tenant: Tenant, conversation: Conversation, actor: Principal, external?: boolean): Promise<Resolution>;
}

export function conversationScope(
  conversation: Pick<Conversation, "kind" | "channelRef" | "threadRef">,
  actorId: string,
): ScopeId {
  if (conversation.kind === "dm") return scopeId("personal", actorId);
  const ref = conversation.channelRef ?? conversation.threadRef;
  if (conversation.kind === "group") return scopeId("group", ref);
  return scopeId("channel", ref);
}

export function composeSoul(orgSoul: string | null, scopeSoul: string | null): string {
  const parts: string[] = [];
  if (orgSoul?.trim()) parts.push(`## Organization instructions\n${orgSoul}`);
  if (scopeSoul?.trim() && scopeSoul.trim() !== orgSoul?.trim()) {
    parts.push(
      `## Conversation instructions${orgSoul?.trim() ? " (organization instructions take precedence)" : ""}\n${scopeSoul}`,
    );
  }
  return parts.join("\n\n");
}

export function createResolutionService(
  orgId: string,
  config: ScopedConfigStore,
  acl: AclStore,
  screening: SecurityScreenMode = "enforce",
): ResolutionService {
  const orgScope = scopeId("org", orgId);

  function scopeFor(conversation: Conversation, actor: Principal): ScopeId {
    return conversationScope(conversation, actor.id);
  }

  return {
    scopeFor,
    async resolve(tenant, conversation, actor, external = false): Promise<Resolution> {
      const scope = scopeFor(conversation, actor);
      const isDm = conversation.kind === "dm";
      const liveConfigScopes = new Set<ScopeId>([orgScope, scope, scopeId("personal", actor.id)]);
      for (const principal of conversation.audience) {
        liveConfigScopes.add(scopeId("personal", principal.id));
        for (const team of principal.teamIds ?? []) liveConfigScopes.add(scopeId("team", team));
      }
      await config.refreshSecurity([...liveConfigScopes]);

      const readOnlyScopeIds = external
        ? []
        : [orgScope, ...((isDm ? actor.teamIds : conversation.teamIds) ?? []).map((tid) => scopeId("team", tid))];

      const orgSoul = external ? "" : (config.getSoul(orgScope) ?? "");
      const scopeSoul = external ? null : config.getSoul(scope);
      const systemPrompt = composeSoul(orgSoul, scopeSoul);

      const orgPolicy = config.getCommandPolicy(orgScope) ?? defaultOrgPolicy();
      const scopePolicy = config.getCommandPolicy(scope) ?? undefined;
      const commandPolicy = composePolicy(orgPolicy, scopePolicy);
      const securityPolicy = resolveSecurityPolicy(await config.getSecurityPostureDurable(scope), screening);
      const sharingPosture = external
        ? "isolated"
        : await config.resolveSharingPostureDurable(scopeId("personal", actor.id), scope);
      const approvalGrantModes = await config.getApprovalGrantModesDurable(scope);

      const egress = {
        allowedHosts: audienceEgressFloor(conversation.audience, config, orgScope, scope),
        deniedHosts: audienceDeniedFloor(conversation.audience, config, orgScope, scope),
      };

      const grantedHandles = external
        ? []
        : await acl.handlesForAudience(tenant, conversation.audience, scope, orgScope, entitledScopes);

      return {
        writableScopeId: scope,
        readOnlyScopeIds,
        systemPrompt,
        egress,
        commandPolicy,
        securityPolicy,
        sharingPosture,
        approvalGrantModes,
        orgScopeId: orgScope,
        grantedHandles,
        ...(scopeSoul?.trim() ? { guidance: scopeSoul } : {}),
      };
    },
  };
}
