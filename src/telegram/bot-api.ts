export interface TelegramMessage {
  messageId: number;
  chatId: string;
  chatType: string;
  userId: string;
  userName?: string;
  text?: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  isBot?: boolean;
}

export interface TelegramUpdate {
  updateId: number;
  message?: TelegramMessage;
}

export interface TelegramApi {
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string, opts?: { replyToMessageId?: number }): Promise<void>;
  sendDocument(chatId: string, fileName: string, bytes: Uint8Array): Promise<void>;
  stop(): Promise<void>;
}

function userNameOf(from: { username?: string; first_name?: string }): string | undefined {
  if (from.username) return from.username;
  return from.first_name;
}

export function createTelegramApi(deps: { botToken: string; apiUrl?: string; fetchImpl?: typeof fetch }): TelegramApi {
  const apiUrl = (deps.apiUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;
  let stopped = false;

  async function call(method: string, body: Record<string, unknown>): Promise<any> {
    if (stopped && method !== "getUpdates") throw new Error("telegram api stopped");
    const res = await fetchImpl(`${apiUrl}/bot${deps.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`telegram api ${method} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!json.ok) throw new Error(`telegram api ${method} failed: ${json.description ?? "unknown error"}`);
    return json.result;
  }

  return {
    async getUpdates(offset, timeoutSec) {
      const result = await call("getUpdates", {
        offset,
        timeout: timeoutSec,
        allowed_updates: ["message"],
      });
      return (
        result as Array<{
          update_id: number;
          message?: {
            message_id: number;
            chat: { id: number; type: string };
            from: { id: number; first_name?: string; username?: string; is_bot?: boolean };
            text?: string;
            reply_to_message?: { message_id?: number };
            message_thread_id?: number;
          };
        }>
      ).map((u) => ({
        updateId: u.update_id,
        ...(u.message
          ? {
              message: {
                messageId: u.message.message_id,
                chatId: String(u.message.chat.id),
                chatType: u.message.chat.type,
                userId: String(u.message.from.id),
                ...(userNameOf(u.message.from) ? { userName: userNameOf(u.message.from) } : {}),
                ...(u.message.text !== undefined ? { text: u.message.text } : {}),
                ...(u.message.reply_to_message?.message_id !== undefined
                  ? { replyToMessageId: u.message.reply_to_message.message_id }
                  : {}),
                ...(u.message.message_thread_id !== undefined ? { messageThreadId: u.message.message_thread_id } : {}),
                ...(u.message.from.is_bot ? { isBot: u.message.from.is_bot } : {}),
              },
            }
          : {}),
      }));
    },
    async sendMessage(chatId, text, opts) {
      await call("sendMessage", {
        chat_id: chatId,
        text,
        ...(opts?.replyToMessageId ? { reply_to_message_id: opts.replyToMessageId } : {}),
      });
    },
    async sendDocument(chatId, fileName, bytes) {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("document", new Blob([bytes]), fileName);
      const res = await fetchImpl(`${apiUrl}/bot${deps.botToken}/sendDocument`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`telegram api sendDocument failed: HTTP ${res.status}`);
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) throw new Error(`telegram api sendDocument failed: ${json.description ?? "unknown error"}`);
    },
    async stop() {
      stopped = true;
    },
  };
}
