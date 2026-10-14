import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { UserOAuthTokens } from "./user-model-credential-store.ts";
import { chatgptAccountIdFromToken } from "./chatgpt-auth-file.ts";
import type { ChatGPTDevicePrompt } from "./subscription-oauth.ts";

const LOGIN_TTL_MS = 15 * 60 * 1000;
const START_TIMEOUT_MS = 30_000;
const DEVICE_CODE_METHOD = "device_code";

interface PendingLogin {
  abort: AbortController;
  expiresAt: number;
  outcome: Promise<UserOAuthTokens>;
  settled: boolean;
}

function tokensFromCredential(credential: OAuthCredential): UserOAuthTokens {
  const accountId =
    (typeof credential.accountId === "string" && credential.accountId) || chatgptAccountIdFromToken(credential.access);
  if (!credential.access || !credential.refresh || !accountId)
    throw new Error("ChatGPT login completed without a usable subscription token");
  return {
    accessToken: credential.access,
    refreshToken: credential.refresh,
    accountId,
    ...(typeof credential.expires === "number" ? { expiresAt: credential.expires } : {}),
  };
}

export function createCodexDeviceLogin(opts: { oauth?: OAuthAuth } = {}) {
  const pending = new Map<string, PendingLogin>();

  const cleanup = (loginId: string, login: PendingLogin): void => {
    pending.delete(loginId);
    login.abort.abort();
  };

  const sweep = (): void => {
    const now = Date.now();
    for (const [loginId, login] of pending) if (now > login.expiresAt) cleanup(loginId, login);
  };

  return {
    async start(): Promise<ChatGPTDevicePrompt> {
      sweep();
      const oauth = opts.oauth ?? openaiCodexProvider().auth.oauth;
      if (!oauth) throw new Error("ChatGPT subscription login is unavailable");
      const abort = new AbortController();
      let shown!: (event: Extract<AuthEvent, { type: "device_code" }>) => void;
      const devicePrompt = new Promise<Extract<AuthEvent, { type: "device_code" }>>((resolve) => {
        shown = resolve;
      });
      const outcome = oauth
        .login({
          signal: abort.signal,
          async prompt(prompt: AuthPrompt) {
            if (prompt.type === "select" && prompt.options.some((option) => option.id === DEVICE_CODE_METHOD))
              return DEVICE_CODE_METHOD;
            throw new Error(`unsupported ChatGPT login prompt ${prompt.type}`);
          },
          notify(event: AuthEvent) {
            if (event.type === "device_code") shown(event);
          },
        })
        .then(tokensFromCredential);
      void outcome.catch(() => undefined);
      let startTimer: NodeJS.Timeout | undefined;
      try {
        const event = await Promise.race([
          devicePrompt,
          outcome.then(() => {
            throw new Error("ChatGPT login finished before showing a device code");
          }),
          new Promise<never>((_, reject) => {
            startTimer = setTimeout(() => reject(new Error("ChatGPT device login start timed out")), START_TIMEOUT_MS);
          }),
        ]);
        const loginId = randomUUID();
        const expiresAt = Date.now() + Math.min(LOGIN_TTL_MS, (event.expiresInSeconds ?? Infinity) * 1000);
        const login: PendingLogin = { abort, expiresAt, outcome, settled: false };
        void outcome
          .catch(() => undefined)
          .finally(() => {
            login.settled = true;
          });
        pending.set(loginId, login);
        return {
          deviceAuthId: loginId,
          userCode: event.userCode,
          verificationUrl: event.verificationUri,
          intervalMs: (event.intervalSeconds ?? 5) * 1000,
          expiresAt,
        };
      } catch (error) {
        abort.abort();
        throw error;
      } finally {
        if (startTimer) clearTimeout(startTimer);
      }
    },

    async poll(loginId: string): Promise<UserOAuthTokens | "pending"> {
      sweep();
      const login = pending.get(loginId);
      if (!login) throw new Error("login expired or unknown — start again");
      if (!login.settled) return "pending";
      try {
        return await login.outcome;
      } finally {
        cleanup(loginId, login);
      }
    },

    async close(): Promise<void> {
      for (const [loginId, login] of pending) cleanup(loginId, login);
    },
  };
}
