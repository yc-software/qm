const SOURCES: Record<string, string> = { cron: "Scheduled task", webhook: "Webhook", monitor: "Monitor" };

export function viaSourceText(via: string, title?: string): string {
  return title?.trim() || SOURCES[via] || via;
}
