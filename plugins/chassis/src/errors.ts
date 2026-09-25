export function errMessage(e: unknown, fallback?: string): string {
  if (e instanceof Error) return e.message;
  if (fallback !== undefined) return fallback;
  if (typeof e === "string") return e;
  if (e === null || (typeof e !== "object" && typeof e !== "function")) return String(e);
  if ("message" in e && typeof e.message === "string") return e.message;
  return "Unknown error";
}

export function swallow(context: string, e: unknown): void {
  console.warn(`[swallowed] ${context}: ${errMessage(e)}`);
}
