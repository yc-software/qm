import { SNOWFLAKE, snowflakeMs } from "./snowflake.ts";

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function xmlAttrEscape(s: string): string {
  return xmlEscape(s).replace(/"/g, "&quot;");
}

export function messageTsMs(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  if (SNOWFLAKE.test(ts)) return snowflakeMs(ts);
  const n = Number.parseFloat(ts);
  return Number.isFinite(n) && n > 0 ? Math.floor(n * 1000) : undefined;
}

export function isoFromTs(ts: string | undefined): string {
  const ms = messageTsMs(ts);
  return ms === undefined ? "" : new Date(ms).toISOString();
}

export interface MessageTagAttrs {
  id?: string;
  from?: "human" | "agent";
  author?: string;
  authorId?: string;
  via?: string;
  sentAt?: string;
  overheard?: boolean;
  trigger?: boolean;
  mentions?: Record<string, string>;
}

export function messageTag(attrs: MessageTagAttrs, body: string, files?: readonly string[]): string {
  const parts = [
    attrs.overheard ? `overheard="true"` : "",
    attrs.id ? `id="${xmlAttrEscape(attrs.id)}"` : "",
    attrs.from ? `from="${attrs.from}"` : "",
    attrs.author ? `author="${xmlAttrEscape(attrs.author)}"` : "",
    attrs.authorId ? `author-id="${xmlAttrEscape(attrs.authorId)}"` : "",
    attrs.via ? `via="${xmlAttrEscape(attrs.via)}"` : "",
    attrs.sentAt ? `sent-at="${attrs.sentAt}"` : "",
    files?.length ? `files="${xmlAttrEscape(files.join(", "))}"` : "",
    attrs.mentions && Object.keys(attrs.mentions).length
      ? `mentions="${xmlAttrEscape(
          Object.entries(attrs.mentions)
            .map(([id, name]) => `${id}=${name}`)
            .join(","),
        )}"`
      : "",
    attrs.trigger ? `trigger="true"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<message ${parts}>${xmlEscape(body)}</message>`;
}
