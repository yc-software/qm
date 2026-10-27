import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { html, nothing, type TemplateResult } from "lit";
import { userItemMessage, type AssistantWork, type SubagentMailRef } from "./transcript-messages";
import type { WorkBlock } from "./core-bridge";
import { activityItems } from "./items";
import { avatarTpl, brandName } from "./ui";
import { appState } from "./shell";
import { contextsState } from "./contexts";
import type { ChatState } from "./chat-state";

export type MessageFields = Partial<{
  role: string;
  opener: boolean;
  resumeAnchor: boolean;
  steered: boolean;
  subagentMail: SubagentMailRef;
  sendFailure: string;
  edited: boolean;
  deleted: boolean;
  speaker: string;
  speakerId: string;
  timestamp: number;
  entrySeq: number;
}>;

export function createMessageRows(chatState: ChatState) {
  const inlineSteers = new Map<number, { message: AgentMessage; index: number }>();
  const steerMessageCache = new WeakMap<WorkBlock["activity"], Array<{ seq: number; message: AgentMessage }>>();

  function prepareMessageRows(messages: AgentMessage[]): void {
    inlineSteers.clear();
    const messageIndices = new Map(messages.map((message, index) => [(message as MessageFields).entrySeq, index]));
    for (const message of messages) {
      const activity = (message as AssistantWork).work?.activity;
      if (!activity) continue;
      let steers = steerMessageCache.get(activity);
      if (!steers) {
        steers = activityItems(activity).flatMap((item) => {
          if (item.kind !== "SteeringMessage") return [];
          const user = userItemMessage(item);
          return user ? [{ seq: item.seq, message: user as AgentMessage }] : [];
        });
        steerMessageCache.set(activity, steers);
      }
      for (const steer of steers) {
        const index = messageIndices.get(steer.seq);
        inlineSteers.set(steer.seq, {
          message: index === undefined ? steer.message : messages[index]!,
          index:
            index === undefined ? -1 : index - (chatState.inheritedExpanded ? chatState.inheritedMessages.length : 0),
        });
      }
    }
    updateSpeakerLabels([...messages, ...[...inlineSteers.values()].map((steer) => steer.message)]);
  }

  function updateSpeakerLabels(messages: AgentMessage[]): void {
    const names = new Set<string>();
    for (const m of messages) {
      const { role, speaker } = m as MessageFields;
      if (role === "user" && typeof speaker === "string" && speaker.trim()) names.add(speaker.trim());
    }
    const viewer = appState.me?.displayName?.trim().toLowerCase();
    chatState.labelSpeakers = names.size > 1 || (Boolean(viewer) && [...names].some((n) => n.toLowerCase() !== viewer));
    chatState.assistantSpeakerLabel = chatState.labelSpeakers ? brandName() : "";
  }

  function speakerLabelFor(message: AgentMessage): string | undefined {
    if (!chatState.labelSpeakers) return undefined;
    const speaker = (message as MessageFields).speaker;
    return typeof speaker === "string" && speaker.trim() ? speaker.trim() : undefined;
  }

  function speakerMember(message: AgentMessage): { principalId: string; avatarUrl?: string } | undefined {
    const speakerId = (message as MessageFields).speakerId;
    if (!speakerId) return undefined;
    const project = contextsState.list.find((c) => c.scopeId === chatState.scopeId)?.project;
    return project?.members.find((m) => m.principalId === speakerId);
  }

  function speakerLabelTpl(speaker: string | undefined, message: AgentMessage): TemplateResult | typeof nothing {
    if (!speaker) return nothing;
    const member = speakerMember(message);
    return html`<div class="speaker-label">
      ${avatarTpl({ key: member?.principalId ?? speaker, name: speaker, avatarUrl: member?.avatarUrl })}<span
        title=${speaker}
        >${speaker.split(/\s+/, 1)[0]!.toLowerCase()}</span
      >
    </div>`;
  }

  return { inlineSteers, prepareMessageRows, speakerLabelFor, speakerLabelTpl, speakerMember };
}
