import type { BuiltApp } from "../../src/wiring.ts";
import { handle, isPrincipalId, type Handle } from "../../src/identity/principals.ts";

/** Test actors are Slack users unless they are email addresses; the fixtures name that provider explicitly. */
export const testHandle = (id: string): Handle => handle(id.includes("@") ? "email" : "slack", id);

export function principalOf(built: Pick<BuiltApp, "principals">, id: string): Promise<string> {
  return isPrincipalId(id) ? Promise.resolve(id) : built.principals.act(testHandle(id));
}

export async function personalScope(built: Pick<BuiltApp, "principals">, id: string): Promise<`personal:${string}`> {
  return `personal:${await principalOf(built, id)}`;
}
