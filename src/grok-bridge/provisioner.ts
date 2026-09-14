import { grokBridgeReplySkill } from "./reply-skill.ts";
import type { ProvisionerPort } from "./types.ts";

export function createManualProvisioner(): ProvisionerPort {
  return {
    skillFor(pairing) {
      return grokBridgeReplySkill({ agentName: pairing.agentName, displayName: pairing.grokDisplayName });
    },
  };
}
