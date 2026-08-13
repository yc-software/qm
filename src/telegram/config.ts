export interface TelegramPluginConfig {
  botToken: string;
  apiUrl?: string;
  allowedChatIds?: string[];
  pollingTimeoutSec?: number;
  fetchImpl?: typeof fetch;
}

export function telegramPluginConfigFromEnv(env: Record<string, string | undefined>): TelegramPluginConfig | null {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const num = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const opt = <K extends keyof TelegramPluginConfig>(
    key: K,
    value: TelegramPluginConfig[K] | undefined,
  ): Partial<TelegramPluginConfig> => (value === undefined ? {} : ({ [key]: value } as Partial<TelegramPluginConfig>));
  return {
    botToken: env.TELEGRAM_BOT_TOKEN,
    ...opt("apiUrl", env.TELEGRAM_API_URL),
    ...(() => {
      const raw = (env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").trim();
      return raw
        ? {
            allowedChatIds: raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {};
    })(),
    ...opt("pollingTimeoutSec", num(env.TELEGRAM_POLLING_TIMEOUT_SEC)),
  };
}
