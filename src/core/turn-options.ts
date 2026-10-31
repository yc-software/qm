import type { RuntimePurpose } from "../resolution/config-store.ts";

export function turnRuntimePurpose(
  input: { surface?: string; triggered?: boolean },
  subagent = false,
): RuntimePurpose | undefined {
  if (subagent) return "subagent";
  if (input.triggered && (input.surface === "cron" || input.surface === "loop")) return "cron";
  return undefined;
}

export function resolveTurnFastMode(
  requested: boolean | undefined,
  humanTurn: boolean,
  interactiveDefault: boolean,
): boolean | undefined {
  if (typeof requested === "boolean") return requested;
  return humanTurn && interactiveDefault ? true : undefined;
}
