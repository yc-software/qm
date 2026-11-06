const SOURCES: Record<string, string> = { cron: "Scheduled task", webhook: "Webhook", monitor: "Monitor" };

export function assistantSpeakerText(name: string, via: string | undefined): string {
  return via ? `${name} · ${SOURCES[via] ?? via}` : name;
}
