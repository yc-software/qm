import type { BuiltApp } from "../../src/wiring.ts";
import type { ScopeId } from "../../src/types.ts";

export async function withSandboxDefaults<T extends Pick<BuiltApp, "sandboxResources">>(
  built: T,
  scopes: ScopeId[],
): Promise<T> {
  await built.sandboxResources.initialize();
  for (const scope of scopes)
    await built.sandboxResources.recordLegacy(scope, built.sandboxResources.defaultBackend(scope), {
      id: `test-${scope}`,
      rootDir: "/workspace",
    });
  return built;
}
