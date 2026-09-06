import type { SessionEntry } from "../types.ts";
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
  visibility: { minSeq: number; maxSeq: number; minCreatedAt: number; maxCreatedAt: number };
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
  entries: SessionEntry[],
  deliveredAttachments: ReadonlyMap<number, string[]> = new Map(),
): ProjectedMessage[] {
  const messages: ProjectedMessage[] = [];
  const posts = new Map<string, string>();
  let posted = false;
  const emit = (role: "user" | "assistant", text: string, files: string[]) => {
    if (!text.trim() && !files.length) return;
    messages.push({ role, text, ...(files.length ? { attachmentIds: [...new Set(files)] } : {}) });
  };
  for (const entry of entries) {
    const p = entry.payload;
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const payload = p as Record<string, unknown>;
    if (entry.type === "user") {
      posted = false;
      posts.clear();
      if (payload.hidden || payload.overheard) continue;
      const text = typeof payload.display === "string" && payload.display.trim() ? payload.display : payload.text;
      emit("user", typeof text === "string" ? text : "", attachmentIds(payload.attachments));
    } else if (entry.type === "tool_call" && payload.action === "post") {
      if (typeof payload.callId === "string")
        posts.set(payload.callId, typeof payload.text === "string" ? payload.text : "");
    } else if (entry.type === "tool_result") {
      const callId = typeof payload.callId === "string" ? payload.callId : "";
      const text = posts.get(callId);
      posts.delete(callId);
      if (payload.isError === true || payload.ok === false) continue;
      if (text !== undefined) {
        emit("assistant", text, attachmentIds(payload.files));
        posted = true;
      }
    } else if (entry.type === "assistant") {
      emit(
        "assistant",
        !posted && typeof payload.text === "string" ? payload.text : "",
        deliveredAttachments.get(entry.seq) ?? [],
      );
      posted = false;
      posts.clear();
    } else if (entry.type === "delivery") {
      const ids = attachmentIds(payload.files);
      const last = messages.at(-1);
      if (ids.length && last?.role === "assistant")
        last.attachmentIds = [...new Set([...(last.attachmentIds ?? []), ...ids])];
      else emit("assistant", "", ids);
    }
  }
  return messages;
}
