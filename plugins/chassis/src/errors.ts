export function errMessage(e: unknown, fallback?: string): string {
  return e instanceof Error ? e.message : (fallback ?? String(e));
}

export function swallow(context: string, e: unknown): void {
  console.warn(`[swallowed] ${context}: ${errMessage(e)}`);
}
