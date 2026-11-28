import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type SlackSending = { id: string; sessionId: string; text: string; speaker: string; speakerId: string };

type Outgoing = { id: string; sessionId: string; ts?: string; message: AgentMessage };

export class SlackOutbox {
  private entries: Outgoing[] = [];

  listen(reply: EventTarget, on: { queued: () => void; sent: () => void; dropped: () => void }): void {
    reply.addEventListener("slack-sending", (e) => {
      const { id, sessionId, text, speaker, speakerId } = (e as CustomEvent<SlackSending>).detail;
      const message = { role: "user", content: text, timestamp: Date.now(), speaker, speakerId } as AgentMessage;
      this.entries = [...this.entries, { id, sessionId, message }];
      on.queued();
    });
    reply.addEventListener("slack-sent", (e) => {
      const { id, ts } = (e as CustomEvent<{ id: string; ts: string }>).detail;
      this.entries = this.entries.map((entry) => (entry.id === id ? { ...entry, ts } : entry));
      on.sent();
    });
    reply.addEventListener("slack-failed", (e) => {
      const { id } = (e as CustomEvent<{ id: string }>).detail;
      this.entries = this.entries.filter((entry) => entry.id !== id);
      on.dropped();
    });
  }

  confirm(sessionId: string, messages: readonly AgentMessage[]): void {
    const posted = new Set(messages.map((message) => (message as { ts?: string }).ts));
    this.entries = this.entries.filter((entry) => entry.sessionId !== sessionId || !entry.ts || !posted.has(entry.ts));
  }

  pending(sessionId: string): AgentMessage[] {
    return this.entries.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.message);
  }

  sending(message: AgentMessage): boolean {
    return this.entries.some((entry) => entry.message === message);
  }
}
