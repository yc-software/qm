import { errMessage } from "../util/errors.ts";
import type { ActorAssertion, ConversationKind, TurnResult } from "../types.ts";
import type { CoreBridge, CoreTurnBody } from "../api/core-bridge.ts";
import type { TelegramApi } from "./bot-api.ts";

export interface TelegramIncoming {
  chatId: string;
  userId: string;
  userName?: string;
  text: string;
  messageId: number;
  replyToMessageId?: number;
  isGroup: boolean;
  isBotCommand: boolean;
}

export interface TurnHandlerDeps {
  bridge: CoreBridge;
  api: TelegramApi;
}

export interface TurnHandler {
  handleIncoming(inc: TelegramIncoming): Promise<void>;
}

export function telegramThreadRef(chatId: string, replyToMessageId?: number): string {
  return replyToMessageId ? `dm:${chatId}:${replyToMessageId}` : `dm:${chatId}`;
}

export function createTurnHandler(deps: TurnHandlerDeps): TurnHandler {
  const { bridge, api } = deps;
  const { callCore, inFlightRunByThread } = bridge;

  const postReply = async (chatId: string, text: string, replyToMessageId?: number): Promise<void> => {
    const chunks = splitText(text);
    for (let i = 0; i < chunks.length; i++) {
      await api.sendMessage(chatId, chunks[i]!, {
        ...(i === 0 && replyToMessageId ? { replyToMessageId } : {}),
      });
    }
  };

  async function handleIncoming(inc: TelegramIncoming): Promise<void> {
    const text = inc.text.trim();
    if (!text) return;

    const actor: ActorAssertion = {
      externalId: inc.userId,
      ...(inc.userName ? { displayName: inc.userName } : {}),
    };

    const kind: ConversationKind = inc.isGroup ? "channel" : "dm";
    const threadRef = telegramThreadRef(inc.chatId, inc.replyToMessageId);

    const turn: CoreTurnBody = {
      actor,
      conversation: {
        kind,
        threadRef,
        ...(inc.isGroup ? { channelRef: inc.chatId } : {}),
        audience: [actor],
      },
      deliveryTarget: inc.chatId,
      text,
      gatewayContext: {
        location: inc.isGroup ? `a group chat (${inc.chatId})` : "a direct message with the user",
        details: {
          chat_id: inc.chatId,
          ...(inc.isGroup ? { group: "true" } : {}),
        },
      },
      liveActor: true,
      triggerTs: String(inc.messageId),
    };

    let result: TurnResult;
    let queuedRunId: string | undefined;
    try {
      result = await callCore(turn, {
        onQueued: (runId) => {
          queuedRunId = runId;
          inFlightRunByThread.set(threadRef, runId);
        },
      });
    } catch (err) {
      console.error(`[telegram-plugin] turn error chat=${inc.chatId}: ${errMessage(err)}`);
      await api.sendMessage(inc.chatId, `⚠️ ${errMessage(err)}`, {
        ...(inc.replyToMessageId ? { replyToMessageId: inc.replyToMessageId } : {}),
      });
      return;
    } finally {
      if (queuedRunId) inFlightRunByThread.clear(threadRef, queuedRunId);
    }

    if (result.status === "silent") {
      console.error(`[telegram-plugin] turn.silent (no reply) chat=${inc.chatId}`);
      return;
    }

    if (result.status === "ok" || result.status === "refused") {
      const reply = result.reply?.trim();
      if (reply) {
        await postReply(inc.chatId, reply, inc.replyToMessageId);
      }
    } else {
      console.error(`[telegram-plugin] turn ${result.status} chat=${inc.chatId}: ${result.reason ?? "refused"}`);
    }
  }

  return { handleIncoming };
}

export function splitText(text: string, maxLen = 4096): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = rest.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
