import type { SessionStatus } from "../types.ts";

const emojiPattern = new RegExp("^\\p{RGI_Emoji}$", "v");

export function isSessionStatus(value: unknown): value is SessionStatus | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Partial<SessionStatus>;
  return (
    typeof status.emoji === "string" &&
    emojiPattern.test(status.emoji) &&
    typeof status.text === "string" &&
    status.text.isWellFormed() &&
    status.text.trim().length > 0 &&
    status.text.length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(status.text)
  );
}
