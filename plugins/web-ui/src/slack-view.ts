import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CoreSession } from "./core-bridge";

export function hiddenMessage(message: AgentMessage): boolean {
  const { opener, resumeAnchor } = message as { opener?: boolean; resumeAnchor?: boolean };
  return Boolean(opener || resumeAnchor);
}

export function continuedSpeakers(rows: readonly AgentMessage[]): Set<AgentMessage> {
  const continued = new Set<AgentMessage>();
  let previous: string | undefined;
  for (const message of rows) {
    const { role, speaker, speakerId } = message as { role?: string; speaker?: string; speakerId?: string };
    const key = role === "user" ? speakerId || speaker : undefined;
    if (key && key === previous) continued.add(message);
    previous = key;
  }
  return continued;
}

export function slackAppIcon(
  session: CoreSession | null,
  message: AgentMessage,
  iconUrl: string | null | undefined,
): string | undefined {
  const wornPersona = Boolean((message as { personaId?: string }).personaId);
  return session?.surface === "slack" && !wornPersona ? iconUrl || undefined : undefined;
}

export function fromSomeoneElse(message: AgentMessage, viewer: string | undefined): boolean {
  const { speakerId, overheard } = message as { speakerId?: string; overheard?: boolean };
  return speakerId ? Boolean(viewer) && speakerId !== viewer : Boolean(overheard);
}
