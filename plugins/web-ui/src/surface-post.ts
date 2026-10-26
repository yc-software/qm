import type { Item } from "./items.ts";

export function postCallText(call: Pick<Item, "body">): string | null {
  const { action, text, files } = call.body;
  if (action !== "post" || typeof text !== "string") return null;
  if (!text.trim() && !(Array.isArray(files) && files.length)) return null;
  return text;
}

export function postResultOk(result: Pick<Item, "isError" | "body">): boolean {
  const { ok, error, denied, blocked } = result.body;
  return result.isError !== true && ok !== false && !error && denied !== true && !blocked;
}
