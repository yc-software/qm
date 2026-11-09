export interface TranscriptMessage {
  ts: string;
  at: number;
  author: string;
  owner: boolean;
  text: string;
  attachments?: number;
}

export interface Conversation {
  source: "slack" | "gmail";
  label: string;
  rootTs?: string;
  messages: TranscriptMessage[];
}

const TRANSCRIPT_TAIL = 30;
const MESSAGE_CHARS = 3000;

export function newestTs(conversation: Pick<Conversation, "messages">): string | undefined {
  return conversation.messages.at(-1)?.ts;
}

export function transcriptWindow(conversation: Conversation, tail = TRANSCRIPT_TAIL): TranscriptMessage[] {
  const { messages, rootTs } = conversation;
  const ownerLast = messages.findLastIndex((message) => message.owner);
  const sinceOwner = ownerLast >= 0 ? messages.length - ownerLast : 0;
  const keep = Math.max(tail, sinceOwner);
  const window = messages.slice(Math.max(0, messages.length - keep));
  const root = rootTs ? messages.find((message) => message.ts === rootTs) : undefined;
  return root && !window.includes(root) ? [root, ...window] : window;
}

export function renderTranscript(messages: readonly TranscriptMessage[]): string {
  return messages
    .map((message) => {
      const who = message.owner ? `owner (${message.author})` : message.author;
      const body = message.text.trim().slice(0, MESSAGE_CHARS) || "(no text)";
      const files = message.attachments
        ? ` [${message.attachments} attachment${message.attachments === 1 ? "" : "s"}]`
        : "";
      return `[ts=${message.ts}] ${new Date(message.at).toISOString()} ${who}: ${body}${files}`;
    })
    .join("\n");
}
