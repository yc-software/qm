import { swallowAs } from "../util/errors.ts";
import { createCoreBridge } from "../api/core-bridge.ts";
import type { CoreClient } from "../api/core-client.ts";
import { createTelegramApi, type TelegramUpdate } from "./bot-api.ts";
import { telegramPluginConfigFromEnv, type TelegramPluginConfig } from "./config.ts";
import { createTurnHandler, type TelegramIncoming, type TurnHandler } from "./turn-handler.ts";
import { createDeliveryPoller } from "./deliveries.ts";

export type { TelegramPluginConfig };
export { telegramPluginConfigFromEnv };

const POLLING_DEFAULT_TIMEOUT_SEC = 25;
const POLLING_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const POLLING_EMPTY_BATCH_DELAY_MS = 200;
const DELIVERY_POLL_MS = 5_000;

export async function startTelegramPlugin(
  cfg: TelegramPluginConfig,
  core: CoreClient,
): Promise<{ stop(): Promise<void> }> {
  const api = createTelegramApi({
    botToken: cfg.botToken,
    ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}),
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  });
  const allowed = new Set(cfg.allowedChatIds ?? []);
  const pollingTimeoutSec = cfg.pollingTimeoutSec ?? POLLING_DEFAULT_TIMEOUT_SEC;
  let stopped = false;

  const bridge = createCoreBridge(core, "telegram");
  const handler: TurnHandler = createTurnHandler({ bridge, api });

  const deliveries = createDeliveryPoller({ core, bridge, api });

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;
    if (msg.isBot) return;
    if (allowed.size > 0 && !allowed.has(msg.chatId)) {
      console.error(`[telegram-plugin] ignoring message from unlisted chat ${msg.chatId}`);
      return;
    }
    const inc: TelegramIncoming = {
      chatId: msg.chatId,
      userId: msg.userId,
      ...(msg.userName ? { userName: msg.userName } : {}),
      text: msg.text ?? "",
      messageId: msg.messageId,
      ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}),
      isGroup: msg.chatType !== "private",
      isBotCommand: false,
    };
    if (inc.isGroup) {
      console.error(`[telegram-plugin] group chats aren't supported yet — ignoring chat ${msg.chatId}`);
      return;
    }
    await handler.handleIncoming(inc);
  }

  async function poll(): Promise<void> {
    let offset = 0;
    let failureStreak = 0;
    while (!stopped) {
      try {
        const updates = await api.getUpdates(offset, pollingTimeoutSec);
        failureStreak = 0;
        for (const update of updates) {
          if (update.updateId >= offset) offset = update.updateId + 1;
          await handleUpdate(update).catch(swallowAs("telegram: update handling", undefined));
        }
        if (updates.length === 0) await new Promise((resolve) => setTimeout(resolve, POLLING_EMPTY_BATCH_DELAY_MS));
      } catch (err) {
        swallowAs("telegram: polling", undefined)(err);
        if (stopped) return;
        const delay = POLLING_RETRY_DELAYS_MS[Math.min(failureStreak, POLLING_RETRY_DELAYS_MS.length - 1)]!;
        failureStreak++;
        console.error(`[telegram-plugin] polling error (retry in ${delay}ms): ${(err as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  let deliveriesPollInFlight = false;
  let deliveriesPollAgain = false;
  const drainDeliveries = (): void => {
    if (stopped) return;
    if (deliveriesPollInFlight) {
      deliveriesPollAgain = true;
      return;
    }
    deliveriesPollInFlight = true;
    void deliveries.pollDeliveries().finally(() => {
      deliveriesPollInFlight = false;
      if (deliveriesPollAgain) {
        deliveriesPollAgain = false;
        drainDeliveries();
      }
    });
  };
  const unsubscribeDeliveries = core.onDeliveryEnqueued(drainDeliveries);
  const deliveriesTimer = setInterval(drainDeliveries, DELIVERY_POLL_MS);
  deliveriesTimer.unref();

  void poll();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(deliveriesTimer);
      unsubscribeDeliveries();
      await api.stop().catch(swallowAs("telegram: api stop", undefined));
    },
  };
}
