import type { Keychain, KeychainCredentialMeta } from "../credentials/keychain.ts";
import type { ScopeId } from "../types.ts";
import { personalScope } from "../types.ts";
import { canonicalJson } from "../util/objects.ts";
import { createComposioAdapter } from "./composio.ts";

export interface IntegrationRequest {
  action: "status" | "catalog" | "search" | "connections" | "connect" | "execute" | "disconnect";
  credential?: string;
  toolkit?: string;
  search?: string;
  cursor?: string;
  connection?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}

export function createIntegrationHelper(options: {
  keychain: Keychain;
  orgScopeId: ScopeId;
  scopeId: ScopeId;
  actorId: string;
  grantedCredentials: () => Promise<string[]>;
  approve: (command: string) => void;
  audit: (action: string, resource: string) => void;
}) {
  const { keychain, orgScopeId, scopeId, actorId } = options;
  const tenantId = orgScopeId.replace(/^org:/, "");
  const actor = { tenantId, principalId: actorId, scopeId };
  async function visible(): Promise<KeychainCredentialMeta[]> {
    const own = scopeId === personalScope(actorId) ? await keychain.listByOwner(actorId) : [];
    const shared = (await keychain.grantsForScope(scopeId)).map((g) => g.credential);
    return [
      ...new Map(
        [...own, ...shared].filter((c) => c.kind === "connection" && c.orgId === tenantId).map((c) => [c.id, c]),
      ).values(),
    ];
  }
  return async (request: IntegrationRequest): Promise<unknown> => {
    const allowed = await options.grantedCredentials();
    const providers = (await keychain.listServiceCredentials(orgScopeId)).filter(
      (c) => c.provider === "composio" && c.enabled && c.hasSecret && allowed.includes(c.slug),
    );
    if (request.action === "status")
      return {
        available: providers.length > 0,
        providers: providers.map((c) => ({ credential: c.slug, provider: c.provider })),
      };
    const defaultProvider = providers.length === 1 ? providers[0] : undefined;
    const provider = request.credential ? providers.find((c) => c.slug === request.credential) : defaultProvider;
    if (!provider)
      throw new Error("No unambiguous integration provider available; use status to choose an authorized provider");
    const secret = await keychain.getServiceCredentialSecret(orgScopeId, provider.slug);
    if (!secret?.enabled || secret.provider !== "composio" || secret.delivery !== "broker")
      throw new Error("Integration provider unavailable");
    const connections = (await visible()).filter((c) => c.connection?.credential === provider.slug);
    if (request.action === "connections")
      return connections.map((c) => ({ connection: c.id, toolkit: c.connection!.toolkit, owner: c.ownerId }));
    const adapter = createComposioAdapter({
      apiKey: secret.secret,
      authorize: async (_actor, operation) => {
        const toolkit = operation.tool?.toolkit?.slug ?? operation.toolkit;
        const candidates = connections.filter(
          (c) =>
            (!request.connection || c.id === request.connection) && (!toolkit || c.connection?.toolkit === toolkit),
        );
        const selected = candidates.length === 1 ? candidates[0] : undefined;
        if (operation.action === "execute" || operation.action === "disconnect") {
          if (request.connection && !selected) throw new Error("Connection is not authorized here");
          if (!selected && (operation.action !== "execute" || operation.tool?.isNoAuth !== true))
            throw new Error("Choose an authorized connection; connect the app first if none exists");
          const command = `integrations ${operation.action} ${operation.tool?.slug ?? selected?.connection?.toolkit ?? ""} ${canonicalJson({ credential: provider.slug, connection: selected?.id, version: operation.tool?.version, arguments: operation.arguments })}`;
          options.approve(command);
          if (selected) {
            const current =
              operation.action === "disconnect"
                ? await keychain.getCredential(selected.id)
                : await keychain.useConnection(selected.id, scopeId, actorId);
            if (!current?.connection || current.connection.accountId !== selected.connection?.accountId)
              throw new Error("Connection was removed or changed");
            if (operation.action === "disconnect") {
              if (scopeId !== personalScope(actorId) || current.ownerId !== actorId)
                throw new Error("Only the owner can disconnect in their personal conversation");
              if (!(await keychain.remove(actorId, selected.id))) throw new Error("Connection could not be revoked");
            }
          }
        }
        options.audit(`integration.${operation.action}`, operation.tool?.slug ?? toolkit ?? provider.slug);
        return selected
          ? {
              tenantId,
              ownerId: selected.ownerId,
              accountId: selected.connection!.accountId,
              toolkit: selected.connection!.toolkit,
            }
          : undefined;
      },
    });
    if (request.action === "catalog") return adapter.catalog(request.cursor);
    if (request.action === "search") return adapter.discover(request.search ?? "", request.toolkit);
    if (request.action === "connect") {
      if (!request.toolkit) throw new Error("toolkit required");
      if (scopeId !== personalScope(actorId))
        throw new Error("Connect the app in your own personal conversation first");
      const link = await adapter.connect(actor, request.toolkit);
      return {
        connectUrl: link.connectUrl,
        status: "pending",
        message:
          "Complete consent and the authenticated return flow, then check connections. A browser success page alone does not activate access.",
      };
    }
    if (request.action === "execute") {
      if (!request.tool) throw new Error("tool required; use search for the exact schema");
      return adapter.execute(actor, request.tool, request.arguments ?? {}, request.connection);
    }
    if (request.action === "disconnect") {
      if (!request.connection) throw new Error("connection required");
      await adapter.disconnect(actor, request.connection);
      return { disconnected: true };
    }
    throw new Error("Unknown integration action");
  };
}
