import { isAgentReply, isHidden, isOverheard, isUserItem, type Item } from "./items.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface SharedAttachment {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
}

export interface SharedMessage {
  role: "user" | "assistant";
  text: string;
  attachments?: SharedAttachment[];
}

export interface SessionShare {
  token: string;
  sessionId: string;
  audience: "internal" | "external";
  createdBy: string;
  createdAt: number;
  messages: SharedMessage[];
  files: Array<SharedAttachment & { blobKey: string }>;
}

export type SessionShareStore = DurableMap<SessionShare>;

interface ProjectedMessage {
  role: "user" | "assistant";
  text: string;
  attachmentIds?: string[];
}

function attachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) =>
    file && typeof file === "object" && typeof file.artifactId === "string" ? [file.artifactId] : [],
  );
}

export function sharedMessages(
  items: Item[],
  deliveredAttachments: ReadonlyMap<number, string[]> = new Map(),
): ProjectedMessage[] {
  const messages: ProjectedMessage[] = [];
  const posts = new Map<string, string>();
  let posted = false;
  const emit = (role: "user" | "assistant", text: string, files: string[]) => {
    if (!text.trim() && !files.length) return;
    messages.push({ role, text, ...(files.length ? { attachmentIds: [...new Set(files)] } : {}) });
  };
  for (const item of items) {
    const body = item.body;
    if (isUserItem(item)) {
      posted = false;
      posts.clear();
      if (isHidden(item) || isOverheard(item)) continue;
      const text = typeof body.display === "string" && body.display.trim() ? body.display : (item.text ?? "");
      emit("user", text, attachmentIds(body.attachments));
    } else if (item.kind === "ToolCall" && body.action === "post") {
      if (item.callId) posts.set(item.callId, typeof body.text === "string" ? body.text : "");
    } else if (item.kind === "ToolResult") {
      const callId = item.callId ?? "";
      const text = posts.get(callId);
      posts.delete(callId);
      if (item.isError === true || body.ok === false) continue;
      if (text !== undefined) {
        emit("assistant", text, attachmentIds(body.files));
        posted = true;
      }
    } else if (isAgentReply(item)) {
      emit("assistant", posted ? "" : (item.text ?? ""), deliveredAttachments.get(item.seq) ?? []);
      posted = false;
      posts.clear();
    } else if (item.kind === "AgentMessage" && item.variant === "files_delivered") {
      const ids = attachmentIds(body.files);
      const last = messages.at(-1);
      if (ids.length && last?.role === "assistant")
        last.attachmentIds = [...new Set([...(last.attachmentIds ?? []), ...ids])];
      else emit("assistant", "", ids);
    }
  }
  return messages;
}
