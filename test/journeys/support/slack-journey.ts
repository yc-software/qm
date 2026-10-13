import type { App as BoltApp, Receiver } from "@slack/bolt";
import { startSlackPlugin } from "../../../src/slack/index.ts";
import { startJourneyApp, type JourneyApp } from "./journey-app.ts";
import { startFakeSlack, type FakeSlack } from "./fake-slack.ts";

export const BOT_USER = "UQMBOT";

export interface SlackJourney {
  app: JourneyApp;
  slack: FakeSlack;
  deliver(
    event: Record<string, unknown>,
    opts?: { eventId?: string; retryNum?: number; retryReason?: string },
  ): Promise<void>;
  action(payload: Record<string, unknown>): Promise<void>;
  restartPlugin(): Promise<void>;
  stop(): Promise<void>;
}

export async function startSlackJourney(seed: (slack: FakeSlack) => void): Promise<SlackJourney> {
  const slack = await startFakeSlack();
  seed(slack);
  const app = await startJourneyApp(
    { maxRequestBytes: 10 * 1024 * 1024, contextWindowTokens: 200_000, maxOutputTokens: 16_000 },
    { securityScreen: "off" },
  );
  let bolt: BoltApp | undefined;
  const receiver: Receiver = {
    init(app) {
      bolt = app;
    },
    start: async () => {},
    stop: async () => {},
  };
  const startPlugin = () =>
    startSlackPlugin(
      { botToken: "xoxb-journey", apiUrl: slack.url, identityEmail: "0", receiverFactory: () => receiver },
      app.built.slackCore,
    );
  let plugin = await startPlugin();
  const process = async (body: Record<string, unknown>, retryNum?: number, retryReason?: string) => {
    let acked = false;
    await bolt!.processEvent({
      body,
      ack: async () => {
        acked = true;
      },
      ...(retryNum !== undefined ? { retryNum } : {}),
      ...(retryReason !== undefined ? { retryReason } : {}),
    });
    if (!acked) throw new Error("Slack event was never acked");
  };
  return {
    app,
    slack,
    deliver(event, opts = {}) {
      return process(
        {
          type: "event_callback",
          team_id: "TJOURNEY",
          api_app_id: "AJOURNEY",
          event_id: opts.eventId ?? `Ev${String(event.ts).replace(".", "")}`,
          event_time: Math.floor(Date.now() / 1000),
          authorizations: [{ team_id: "TJOURNEY", user_id: BOT_USER, is_bot: true }],
          event: { event_ts: event.ts, ...event },
        },
        opts.retryNum,
        opts.retryReason,
      );
    },
    action(payload) {
      return process({ type: "block_actions", team: { id: "TJOURNEY" }, api_app_id: "AJOURNEY", ...payload });
    },
    async restartPlugin() {
      await plugin.stop();
      plugin = await startPlugin();
    },
    async stop() {
      await plugin.stop();
      await app.stop();
      await slack.close();
    },
  };
}
