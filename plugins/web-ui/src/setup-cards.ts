import { activityItems, type RunActivityEntry } from "./items.ts";

export interface SetupCard {
  kind: "apps" | "add_to_slack" | "link_slack";
  toolkit: string;
  callId: string;
}

const KINDS = new Set<string>(["apps", "add_to_slack", "link_slack"]);

export function setupCardsIn(activity: readonly RunActivityEntry[] | undefined): SetupCard[] {
  const cards: SetupCard[] = [];
  for (const item of activityItems(activity ?? [])) {
    const display = item.body.display as { kind?: unknown; toolkit?: unknown } | undefined;
    if (item.kind !== "ToolResult" || item.tool !== "card" || item.isError === true || !item.callId) continue;
    if (typeof display?.kind !== "string" || !KINDS.has(display.kind)) continue;
    if (cards.some((card) => card.callId === item.callId)) continue;
    cards.push({
      kind: display.kind as SetupCard["kind"],
      toolkit: typeof display.toolkit === "string" ? display.toolkit : "",
      callId: item.callId,
    });
  }
  return cards;
}
