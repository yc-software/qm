import type { ApprovalGrantModes, Loop, LoopOutput, ShipGate, ShipGrant } from "../types.ts";
import { contentPart } from "../triggers/trigger-store.ts";
import { hashId } from "../util/crypto.ts";

export type ShipDecision =
  { outcome: "auto"; via: "policy" | "grant"; grantId?: string } | { outcome: "hold" } | { outcome: "undeclared" };

export interface ShipCandidate {
  shipAction: string;
  label?: string;
}

function declaredGate(loop: Loop, shipAction: string): ShipGate | undefined {
  return loop.shipActions.find((policy) => policy.action === shipAction)?.gate;
}

function grantCovers(grant: ShipGrant, loop: Loop, candidate: ShipCandidate): boolean {
  if (
    grant.loopId !== loop.id ||
    grant.policyVersion !== (loop.policyVersion ?? 1) ||
    grant.revokedAt !== undefined ||
    grant.shipAction !== candidate.shipAction
  )
    return false;
  return grant.label === undefined || grant.label === candidate.label;
}

export function decideShip(loop: Loop, candidate: ShipCandidate, grants: ShipGrant[] = []): ShipDecision {
  const gate = declaredGate(loop, candidate.shipAction);
  if (gate === undefined) return { outcome: "undeclared" };
  if (gate === "auto") return { outcome: "auto", via: "policy" };
  const grant = grants.find((g) => grantCovers(g, loop, candidate));
  if (grant) return { outcome: "auto", via: "grant", grantId: grant.id };
  return { outcome: "hold" };
}

export function graduationAllowed(modes?: ApprovalGrantModes): boolean {
  return modes?.always !== false;
}

export function buildShipGrant(input: {
  loopId: string;
  shipAction: string;
  actorId: string;
  policyVersion: number;
  label?: string;
  modes?: ApprovalGrantModes;
}): ShipGrant {
  if (!graduationAllowed(input.modes)) throw new Error("standing ship grants are disabled for this org");
  return {
    id: hashId([
      contentPart(input.loopId),
      contentPart(input.policyVersion),
      contentPart(input.shipAction),
      contentPart(input.label),
    ]),
    loopId: input.loopId,
    shipAction: input.shipAction,
    actorId: input.actorId,
    policyVersion: input.policyVersion,
    createdAt: Date.now(),
    ...(input.label !== undefined ? { label: input.label } : {}),
  };
}

export function outputCandidate(output: Pick<LoopOutput, "shipAction" | "label">): ShipCandidate {
  return { shipAction: output.shipAction, ...(output.label !== undefined ? { label: output.label } : {}) };
}

export function undeclaredShipActions(loop: Loop, outputs: Array<Pick<LoopOutput, "shipAction">>): string[] {
  const declared = new Set(loop.shipActions.map((policy) => policy.action));
  return [...new Set(outputs.map((o) => o.shipAction).filter((action) => !declared.has(action)))];
}
