import type { BuiltApp } from "./compose.ts";
import type { ScopeId } from "../../src/types.ts";

export async function selectDefaultSandbox(built: BuiltApp, actorId: string, ...scopes: ScopeId[]): Promise<void> {
  for (const scopeId of scopes) {
    const resources = built.sandboxResources.forTurn({ actorId, scopeId, isCurrent: async () => true });
    const record = await resources.create(actorId, scopeId, await resources.defaultBackend());
    await resources.setDefault(actorId, scopeId, record.id);
  }
}
