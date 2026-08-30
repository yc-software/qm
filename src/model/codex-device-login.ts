import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAppServer } from "../harness/codex-app-server.ts";
import { codexOAuthAuthFromValue } from "../harness/codex-auth-store.ts";
import { asObject, codexOAuthJwtAccountId, type JsonObject } from "../harness/codex-auth-file.ts";
import type { UserOAuthTokens } from "./user-model-credential-store.ts";
import type { ChatGPTDevicePrompt } from "./subscription-oauth.ts";

const LOGIN_TTL_MS = 15 * 60 * 1000;
const START_TIMEOUT_MS = 30_000;

interface PendingLogin {
  server: CodexAppServer;
  home: string;
  loginId: string;
  expiresAt: number;
  outcome: Promise<UserOAuthTokens>;
  settled: boolean;
}

function tokensFromAuthJson(home: string): UserOAuthTokens {
  const raw = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as unknown;
  const auth = codexOAuthAuthFromValue(raw);
  if (!auth) throw new Error("Codex login completed but wrote no usable ChatGPT auth");
  const tokens = asObject((auth as JsonObject).tokens)!;
  const accessToken = tokens.access_token as string;
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
  const accountId = codexOAuthJwtAccountId(auth) ?? undefined;
  return {
    accessToken,
    refreshToken: tokens.refresh_token as string,
    ...(idToken ? { idToken } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

/**
 * ChatGPT device-code login driven through the vendored Codex binary's own
 * login RPCs (`account/login/start` type `chatgptDeviceCode`) instead of a
 * hand-rolled flow against undocumented endpoints. The app-server runs with a
 * throwaway CODEX_HOME; on completion we harvest the auth.json it wrote and
 * tear everything down — the tokens' durable home is the keychain.
 */
export function createCodexDeviceLogin(opts: { binaryPath?: string; env?: NodeJS.ProcessEnv } = {}) {
  const pending = new Map<string, PendingLogin>();

  const cleanup = async (login: PendingLogin): Promise<void> => {
    pending.delete(login.loginId);
    await login.server.close().catch(() => undefined);
    rmSync(login.home, { recursive: true, force: true });
  };

  const sweep = (): void => {
    const now = Date.now();
    for (const login of pending.values()) {
      if (now > login.expiresAt) void cleanup(login);
    }
  };

  return {
    async start(): Promise<ChatGPTDevicePrompt> {
      sweep();
      const home = mkdtempSync(join(tmpdir(), "qm-codex-login-"));
      const binaryPath = opts.binaryPath ?? resolve("node_modules/.bin/codex");
      let completed!: (tokens: UserOAuthTokens) => void;
      let failed!: (error: Error) => void;
      const outcome = new Promise<UserOAuthTokens>((resolvePromise, rejectPromise) => {
        completed = resolvePromise;
        failed = rejectPromise;
      });
      const server = new CodexAppServer({
        binaryPath,
        cwd: home,
        env: { ...opts.env, CODEX_HOME: home },
        onNotification: async (method, params) => {
          if (method !== "account/login/completed") return;
          const p = (params ?? {}) as Record<string, unknown>;
          if (p.success === true) {
            try {
              completed(tokensFromAuthJson(home));
            } catch (error) {
              failed(error instanceof Error ? error : new Error(String(error)));
            }
          } else {
            failed(new Error(typeof p.error === "string" && p.error ? p.error : "ChatGPT login failed"));
          }
        },
        onRequest: async (method) => {
          throw new Error(`unsupported Codex request ${method}`);
        },
      });
      try {
        let startTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            server.initialize(),
            new Promise<never>((_, reject) => {
              startTimer = setTimeout(
                () => reject(new Error("Codex app-server initialization timed out")),
                START_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          if (startTimer) clearTimeout(startTimer);
        }
        const raw = await server.request("account/login/start", { type: "chatgptDeviceCode" });
        const result = (raw ?? {}) as { loginId?: string; verificationUrl?: string; userCode?: string };
        if (!result.loginId || !result.verificationUrl || !result.userCode)
          throw new Error("Codex device login response missing fields");
        const login: PendingLogin = {
          server,
          home,
          loginId: result.loginId,
          expiresAt: Date.now() + LOGIN_TTL_MS,
          outcome,
          settled: false,
        };
        // Settle-once bookkeeping and teardown on completion either way.
        void outcome
          .catch(() => undefined)
          .finally(() => {
            login.settled = true;
          });
        pending.set(result.loginId, login);
        return {
          deviceAuthId: result.loginId,
          userCode: result.userCode,
          verificationUrl: result.verificationUrl,
          intervalMs: 5_000,
          expiresAt: login.expiresAt,
        };
      } catch (error) {
        await server.close().catch(() => undefined);
        rmSync(home, { recursive: true, force: true });
        throw error;
      }
    },

    /** Poll a pending login: tokens when done, "pending" while waiting. */
    async poll(loginId: string): Promise<UserOAuthTokens | "pending"> {
      sweep();
      const login = pending.get(loginId);
      if (!login) throw new Error("login expired or unknown — start again");
      if (!login.settled) {
        const raced = await Promise.race([login.outcome.catch((e: Error) => e), Promise.resolve("pending" as const)]);
        if (raced === "pending" && !login.settled) return "pending";
      }
      try {
        const tokens = await login.outcome;
        await cleanup(login);
        return tokens;
      } catch (error) {
        await cleanup(login);
        throw error;
      }
    },

    async close(): Promise<void> {
      for (const login of pending.values()) await cleanup(login);
    },
  };
}
