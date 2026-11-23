import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageText } from "./core-bridge";

export type SlackOutgoing = {
  id: string;
  sessionId: string;
  text: string;
  posted: number;
  sent: boolean;
  message: AgentMessage;
};

export type SlackSending = { id: string; text: string; speaker: string; speakerId: string };

function postedCount(messages: AgentMessage[], text: string): number {
  return messages.filter((m) => m.role === "user" && messageText(m) === text).length;
}

export function outgoingSlackMessage(
  sending: SlackSending,
  sessionId: string,
  messages: AgentMessage[],
): SlackOutgoing {
  return {
    id: sending.id,
    sessionId,
    text: sending.text,
    posted: postedCount(messages, sending.text),
    sent: false,
    message: {
      role: "user",
      content: sending.text,
      timestamp: Date.now(),
      speaker: sending.speaker,
      speakerId: sending.speakerId,
    } as AgentMessage,
  };
}

export function unconfirmedSlackMessages(
  outbox: SlackOutgoing[],
  sessionId: string,
  messages: AgentMessage[],
): SlackOutgoing[] {
  return outbox.filter(
    (entry) => entry.sessionId !== sessionId || !entry.sent || postedCount(messages, entry.text) <= entry.posted,
  );
}
