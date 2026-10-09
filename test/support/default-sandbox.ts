import type { BuiltApp } from "../../src/wiring.ts";
import type { ScopeId } from "../../src/types.ts";
import { isPrincipalId } from "../../src/identity/principals.ts";

/** Resolve a fixture handle the way the edge does: surface handles become principal UUIDs. */
async function asPrincipal(built: BuiltApp, id: string): Promise<string> {
  return isPrincipalId(id) ? id : built.principals.act(id);
}

/** Give each scope a default computer. `personal:<handle>` scopes land on the handle's principal. */
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
