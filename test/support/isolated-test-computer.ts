import type { BuiltApp } from "../../src/wiring.ts";
import type { ScopeId } from "../../src/types.ts";

export async function createIsolatedTestComputer(built: BuiltApp, actorId: string, scopeId: ScopeId): Promise<void> {
  await built.featureFlags.setEnabled("command_scoped_credentials", scopeId, true, "test-operator");
  const resource = await built.sandboxResources.create(
    actorId,
    scopeId,
    "sprites",
    "isolated test computer",
    undefined,
    {
      executionMode: "isolated",
    },
  );
  await built.sandboxResources.setDefault(actorId, scopeId, resource.id);
}
