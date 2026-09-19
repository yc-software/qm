import type { SessionEntry } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface SharedAttachment {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
  inlinePreview?: boolean;
  previewId?: string;
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
  inlinePreviewIds?: string[];
  previewPairs?: Array<{ attachmentId: string; previewId: string }>;
}

function attachmentIds(
  value: unknown,
  includePreviews = false,
): { ids: string[]; inline: string[]; pairs: Array<{ attachmentId: string; previewId: string }> } {
  if (!Array.isArray(value)) return { ids: [], inline: [], pairs: [] };
  const ids: string[] = [];
  const inline: string[] = [];
  const pairs: Array<{ attachmentId: string; previewId: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const file = item as { artifactId?: unknown; previewArtifactId?: unknown };
    if (typeof file.artifactId !== "string") continue;
    ids.push(file.artifactId);
    if (includePreviews && typeof file.previewArtifactId === "string") {
      inline.push(file.previewArtifactId);
      pairs.push({ attachmentId: file.artifactId, previewId: file.previewArtifactId });
    }
  }
  return { ids, inline, pairs };
}

export function sharedMessages(
  entries: SessionEntry[],
  deliveredAttachments: ReadonlyMap<number, string[]> = new Map(),
): ProjectedMessage[] {
  const messages: ProjectedMessage[] = [];
  const posts = new Map<string, string>();
  let posted = false;
  const emit = (
    role: "user" | "assistant",
    text: string,
    files: string[],
    inline: string[] = [],
    pairs: Array<{ attachmentId: string; previewId: string }> = [],
  ) => {
    if (!text.trim() && !files.length) return;
    messages.push({
      role,
      text,
      ...(files.length ? { attachmentIds: [...new Set(files)] } : {}),
      ...(inline.length ? { inlinePreviewIds: [...new Set(inline)] } : {}),
      ...(pairs.length ? { previewPairs: pairs } : {}),
    });
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
      const attachments = attachmentIds(payload.attachments, true);
      emit("user", typeof text === "string" ? text : "", attachments.ids, attachments.inline, attachments.pairs);
    } else if (entry.type === "tool_call" && payload.action === "post") {
      if (typeof payload.callId === "string")
        posts.set(payload.callId, typeof payload.text === "string" ? payload.text : "");
    } else if (entry.type === "tool_result") {
      const callId = typeof payload.callId === "string" ? payload.callId : "";
      const text = posts.get(callId);
      posts.delete(callId);
      if (payload.isError === true || payload.ok === false) continue;
      if (text !== undefined) {
        emit("assistant", text, attachmentIds(payload.files).ids);
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
      const ids = attachmentIds(payload.files).ids;
      const last = messages.at(-1);
      if (ids.length && last?.role === "assistant")
        last.attachmentIds = [...new Set([...(last.attachmentIds ?? []), ...ids])];
      else emit("assistant", "", ids);
    }
  }
  return messages;
}
