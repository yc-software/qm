import type { InboxItem } from "../../types.ts";
import { gmailAdapter } from "./gmail.ts";
import { slackAdapter } from "./slack.ts";
import type { SourceAdapter } from "./adapter.ts";

const SOURCE_ADAPTERS: readonly SourceAdapter[] = [gmailAdapter, slackAdapter];

export function sourceAdapter(id: unknown): SourceAdapter | undefined {
  return typeof id === "string" ? SOURCE_ADAPTERS.find((adapter) => adapter.id === id) : undefined;
}

export function adapterForItem(item: InboxItem): SourceAdapter | undefined {
  return sourceAdapter(item.source ?? item.sourcePayload?.source);
}

export type { SourceAdapter } from "./adapter.ts";
