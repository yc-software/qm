import type { BuiltApp } from "../../src/wiring.ts";
import type { ScopeId } from "../../src/types.ts";
import { principalOf as asPrincipal } from "./principal.ts";

export async function selectDefaultSandbox(built: BuiltApp, actorId: string, ...scopes: ScopeId[]): Promise<void> {
  const actor = await asPrincipal(built, actorId);
  for (const raw of scopes) {
    const scopeId = (
      raw.startsWith("personal:") ? `personal:${await asPrincipal(built, raw.slice(9))}` : raw
    ) as ScopeId;
    const resources = built.sandboxResources.forTurn({ actorId: actor, scopeId, isCurrent: async () => true });
    const record = await resources.create(actor, scopeId, resources.defaultBackend());
    await resources.setDefault(actor, scopeId, record.id);
  }
}
