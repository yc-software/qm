import type { LoopItem } from "../../types.ts";
import { gmailAdapter } from "./gmail.ts";
import { slackAdapter } from "./slack.ts";
import type { LoopSourceAdapter } from "./adapter.ts";

const SOURCE_ADAPTERS: readonly LoopSourceAdapter[] = [gmailAdapter, slackAdapter];

export function sourceAdapter(id: unknown): LoopSourceAdapter | undefined {
  return typeof id === "string" ? SOURCE_ADAPTERS.find((adapter) => adapter.id === id) : undefined;
}

export function adapterForItem(item: LoopItem): LoopSourceAdapter | undefined {
  return sourceAdapter(item.source ?? item.sourcePayload?.source);
}

export type { LoopSourceAdapter } from "./adapter.ts";
