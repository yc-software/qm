import { normalizeAgentName } from "./crypto.ts";
import { GrokBridgeError, type GrokPairing } from "./types.ts";

export function requireOwner(pairing: GrokPairing, ownerId: string): void {
  if (pairing.ownerPrincipalId !== ownerId) {
    throw new GrokBridgeError("forbidden", 403, "only the pairing owner can do that");
  }
}

export function requireInternalActor(actorType: "internal" | "guest", action: string): void {
  if (actorType === "guest") {
    throw new GrokBridgeError("forbidden", 403, `guests cannot ${action}`);
  }
}

export function requireAgentName(raw: string): string {
  const agentName = normalizeAgentName(raw);
  if (!agentName) throw new GrokBridgeError("bad_request", 400, "agentName must be a lowercase slug");
  return agentName;
}

export async function requirePairing(
  get: (id: string) => Promise<GrokPairing | null>,
  id: string,
): Promise<GrokPairing> {
  const pairing = await get(id);
  if (!pairing) throw new GrokBridgeError("not_found", 404, "pairing not found");
  return pairing;
}
