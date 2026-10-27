import type { Conversation, Principal, Resolution, ScopeId, WorkspaceLayer } from "../types.ts";
import { scopeId } from "../types.ts";
import { composePolicy, defaultOrgPolicy } from "../policy/command-policy.ts";
import type { ScopedConfigStore } from "./config-store.ts";
import type { AclStore } from "../acl/acl-store.ts";
import { audienceEgressFloor, audienceDeniedFloor } from "./audience-floor.ts";
import { principalEntitledToScope } from "./context-filter.ts";
import { tenant } from "../tenant.ts";

export interface ResolutionService {
  scopeFor(conversation: Conversation, actor: Principal): ScopeId;
  resolve(conversation: Conversation, actor: Principal, external?: boolean): Promise<Resolution>;
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

export function composeInstructions(orgInstructions: string | null, scopeInstructions: string | null): string {
  const parts: string[] = [];
  if (orgInstructions?.trim()) parts.push(`## Organization instructions\n${orgInstructions}`);
  if (scopeInstructions?.trim() && scopeInstructions.trim() !== orgInstructions?.trim()) {
    parts.push(
      `## Conversation instructions${orgInstructions?.trim() ? " (organization instructions take precedence)" : ""}\n${scopeInstructions}`,
    );
  }
  return parts.join("\n\n");
}

export function createResolutionService(config: ScopedConfigStore, acl: AclStore): ResolutionService {
  function scopeFor(conversation: Conversation, actor: Principal): ScopeId {
    return conversationScope(conversation, actor.id);
  }

  return {
    scopeFor,
    async resolve(conversation, actor, external = false): Promise<Resolution> {
      const { orgScope } = tenant();
      const scope = scopeFor(conversation, actor);
      const isDm = conversation.kind === "dm";
      const liveConfigScopes = new Set<ScopeId>([orgScope, scope, scopeId("personal", actor.id)]);
      for (const principal of conversation.audience) {
        liveConfigScopes.add(scopeId("personal", principal.id));
        for (const team of principal.teamIds ?? []) liveConfigScopes.add(scopeId("team", team));
      }
      await config.refreshSecurity([...liveConfigScopes]);

      const layers: WorkspaceLayer[] = [
        ...(!external ? [{ scopeId: orgScope, mountPath: "global", mode: "ro" as const }] : []),
        { scopeId: scope, mountPath: "", mode: "rw" },
      ];
      if (!external) {
        for (const tid of (isDm ? actor.teamIds : conversation.teamIds) ?? []) {
          layers.push({ scopeId: scopeId("team", tid), mountPath: `team-${tid}`, mode: "ro" });
        }
      }

      const orgInstructions = external ? "" : (config.getInstructions(orgScope) ?? "");
      const scopeInstructions = external ? null : config.getInstructions(scope);
      const systemPrompt = composeInstructions(orgInstructions, scopeInstructions);

      const orgPolicy = config.setting("commandPolicy", orgScope) ?? defaultOrgPolicy();
      const scopePolicy = config.setting("commandPolicy", scope) ?? undefined;
      const commandPolicy = composePolicy(orgPolicy, scopePolicy);
      const approvalGrantModes = await config.getApprovalGrantModesDurable(scope);

      const egress = {
        allowedHosts: audienceEgressFloor(conversation.audience, config, orgScope, scope),
        deniedHosts: audienceDeniedFloor(conversation.audience, config, orgScope, scope),
      };

      const grantedHandles = external
        ? []
        : await acl.handlesForAudience(conversation.audience, scope, orgScope, principalEntitledToScope);

      return {
        layers,
        systemPrompt,
        egress,
        commandPolicy,
        approvalGrantModes,
        orgScopeId: orgScope,
        grantedHandles,
      };
    },
  };
}
