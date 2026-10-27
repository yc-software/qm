import type { TurnOrigin } from "../turn-origin.ts";
import type { SecurityScreenVerdict } from "../../security/security-screen.ts";
import type { SecurityScreenHook } from "../../security/security-screener.ts";

export interface ScreeningGateInput {
  readonly hook: SecurityScreenHook;
  readonly surface?: string;
  readonly origin?: TurnOrigin["kind"];
  readonly verdict?: SecurityScreenVerdict;
}

export type ScreeningGateDecision =
  { readonly action: "allow" } | { readonly action: "block"; readonly reason: string };

export const SCREENING_ALLOW: ScreeningGateDecision = { action: "allow" };

export function screeningGate(_input: ScreeningGateInput): ScreeningGateDecision {
  return SCREENING_ALLOW;
}
