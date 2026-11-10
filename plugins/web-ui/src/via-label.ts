const SOURCES: Record<string, string> = { cron: "Scheduled task", webhook: "Webhook", monitor: "Monitor" };

export function sourceText(via: string): string {
  return SOURCES[via] ?? via;
}

export function assistantSpeakerText(name: string, via: string | undefined): string {
  return via ? `${name} · ${sourceText(via)}` : name;
}
