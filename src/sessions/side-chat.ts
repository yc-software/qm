import type { Session } from "../types.ts";

export function isSideChatAnchor(value: unknown): value is Omit<NonNullable<Session["sideChat"]>, "expanded"> {
  if (!value || typeof value !== "object") return false;
  const anchor = value as Record<string, unknown>;
  return (
    typeof anchor.entrySeq === "number" &&
    Number.isSafeInteger(anchor.entrySeq) &&
    anchor.entrySeq >= 0 &&
    typeof anchor.quote === "string" &&
    Boolean(anchor.quote.trim()) &&
    typeof anchor.occurrence === "number" &&
    Number.isSafeInteger(anchor.occurrence) &&
    anchor.occurrence >= 0
  );
}
