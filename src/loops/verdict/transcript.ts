export interface TranscriptMessage {
  ts: string;
  at: number;
  author: string;
  authorId?: string;
  authorDetail?: string;
  owner: boolean;
  text: string;
  images?: string[];
  attachments?: number;
  reply?: { messageId: string; rfcMessageId?: string; to: string[]; cc: string[] };
}

export interface Participant {
  id: string;
  name: string;
  avatarUrl?: string;
}

export interface Conversation {
  source: "slack" | "gmail";
  label: string;
  externalUrl?: string;
  rootTs?: string;
  partial?: boolean;
  messages: TranscriptMessage[];
  participants?: Participant[];
  slack?: { channelId: string; threadTs?: string; isDirectMessage: boolean; channelLabel: string };
  gmail?: { threadId: string; subject?: string; accountEmail?: string };
}

export const TRANSCRIPT_TAIL = 30;
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

export function clipMarked(text: string, max = MESSAGE_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} [cut ${text.length - max} chars]`;
}

export function renderTranscript(messages: readonly TranscriptMessage[]): string {
  return messages
    .map((message) => {
      const who = message.owner ? `owner (${message.author})` : message.author;
      const body = clipMarked(message.text.trim()) || "(no text)";
      const files = message.attachments
        ? ` [${message.attachments} attachment${message.attachments === 1 ? "" : "s"}]`
        : "";
      return `[ts=${message.ts}] ${new Date(message.at).toISOString()} ${who}: ${body}${files}`;
    })
    .join("\n");
}
