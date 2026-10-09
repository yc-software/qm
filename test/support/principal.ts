import type { BuiltApp } from "../../src/wiring.ts";

/** The principal a surface handle resolves to in this app, created on first sight as the edge would. */
export function principalOf(built: Pick<BuiltApp, "principals">, handle: string): Promise<string> {
  return built.principals.act(handle);
}

/** `personal:<principal>` for a surface handle. */
export async function personalScope(
  built: Pick<BuiltApp, "principals">,
  handle: string,
): Promise<`personal:${string}`> {
  return `personal:${await principalOf(built, handle)}`;
}
