import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { createMemoryEventBus, type EventBus } from "../util/event-bus.ts";

interface SlackInstallationEvent {
  version: string;
}

export type SlackInstallationBus = EventBus<SlackInstallationEvent>;

const CHANNEL = "slack_installation";

export function createMemorySlackInstallationBus(): SlackInstallationBus {
  return createMemoryEventBus<SlackInstallationEvent>("slack-installation");
}

export function createPostgresSlackInstallationBus(connectionString: string): SlackInstallationBus {
  return createPostgresNotifyBus<SlackInstallationEvent>(connectionString, CHANNEL, "slack-installation");
}
