import type { TurnRuntimePurpose } from "../resolution/config-store.ts";

export function infrequentCronTurn(input: { surface?: string; triggered: boolean; infrequentCron?: boolean }): boolean {
  return input.triggered && input.surface === "cron" && input.infrequentCron === true;
}

export function turnRuntimePurpose(
  input: { surface?: string; triggered: boolean; infrequentCron?: boolean },
  subagent = false,
): TurnRuntimePurpose | undefined {
  if (subagent) return "subagent";
  if (infrequentCronTurn(input)) return "infrequentCron";
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
