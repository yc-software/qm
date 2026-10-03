import type { BuiltApp } from "../../src/wiring.ts";
import type { ScopeId } from "../../src/types.ts";

export async function selectDefaultSandbox(built: BuiltApp, actorId: string, ...scopes: ScopeId[]): Promise<void> {
  for (const scopeId of scopes) {
    const resources = built.sandboxResources.forTurn({ actorId, scopeId, isCurrent: async () => true });
    const record = await resources.create(actorId, scopeId, resources.defaultBackend());
    await resources.setDefault(actorId, scopeId, record.id);
  }
}
