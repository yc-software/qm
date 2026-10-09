import type { BuiltApp } from "../../src/wiring.ts";

export function principalOf(built: Pick<BuiltApp, "principals">, handle: string): Promise<string> {
  return built.principals.act(handle);
}

export async function personalScope(
  built: Pick<BuiltApp, "principals">,
  handle: string,
): Promise<`personal:${string}`> {
  return `personal:${await principalOf(built, handle)}`;
}
