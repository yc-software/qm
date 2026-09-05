import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { emailConfigured, readConfig, type AuthConfig } from "../src/config.ts";
import type { ClaimStore } from "../../chassis/src/claims.ts";
import type { Mailer, OutgoingEmail } from "../src/email.ts";
import { loadSigningKey } from "../src/keys.ts";
import { TokenSigner } from "../src/tokens.ts";
import { createAuthHandler } from "../src/server.ts";

export const CLIENT_ID = "qm-portal";
export const CLIENT_SECRET = "0123456789abcdef0123456789abcdef";
export const TOKEN_SECRET = "fedcba9876543210fedcba9876543210";
export const ISSUER = "https://agent.example.test/idp";
export const REDIRECT_URI = "https://agent.example.test/auth/callback";

export function signingJwk(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return JSON.stringify(privateKey.export({ format: "jwk" }));
}

export function testEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    AUTH_ISSUER: ISSUER,
    AUTH_CLIENT_ID: CLIENT_ID,
    AUTH_CLIENT_SECRET: CLIENT_SECRET,
    AUTH_TOKEN_SECRET: TOKEN_SECRET,
    AUTH_REDIRECT_URI: REDIRECT_URI,
    AUTH_SIGNING_JWK: signingJwk(),
    AUTH_ALLOWED_EMAILS: "admin@example.com,ops@example.com",
    AUTH_EMAIL_FROM: "qm <no-reply@example.com>",
    AUTH_EMAIL_TRANSPORT: "resend",
    RESEND_API_KEY: "re_test_key",
    ...overrides,
  };
}

export function memoryClaimStore(): ClaimStore & { calls: string[][] } {
  const taken = new Map<string, number>();
  const calls: string[][] = [];
  return {
    calls,
    async claimFirst(ids, expiresAtMs) {
      calls.push([...ids]);
      const now = Date.now();
      for (const id of ids) {
        const held = taken.get(id);
        if (held !== undefined && held > now) continue;
        taken.set(id, expiresAtMs);
        return id;
      }
      return null;
    },
  };
}

export function refusingClaimStore(): ClaimStore {
  return {
    async claimFirst() {
      return null;
    },
  };
}

export function captureMailer(): Mailer & { sent: OutgoingEmail[]; failNext: boolean } {
  const state = {
    sent: [] as OutgoingEmail[],
    failNext: false,
    async send(message: OutgoingEmail): Promise<string> {
      if (state.failNext) {
        state.failNext = false;
        throw new Error("delivery refused");
      }
      state.sent.push(message);
      return "test-message-id";
    },
    async verify(): Promise<string> {
      return "ok";
    },
  };
  return state;
}

export interface Harness {
  cfg: AuthConfig;
  base: string;
  claims: ClaimStore & { calls: string[][] };
  mailer: Mailer & { sent: OutgoingEmail[]; failNext: boolean };
  settle(): Promise<void>;
  close(): Promise<void>;
  now: { ms: number };
}

export async function startHarness(
  options: {
    env?: Record<string, string | undefined>;
    claims?: ClaimStore & { calls: string[][] };
    brandName?: () => string;
    emailAllowed?: (email: string) => Promise<boolean>;
  } = {},
): Promise<Harness> {
  const cfg = readConfig(testEnv(options.env));
  const claims = options.claims ?? memoryClaimStore();
  const mailer = captureMailer();
  const now = { ms: Date.now() };
  const pending: Array<Promise<void>> = [];
  const handle = createAuthHandler({
    cfg,
    signingKey: await loadSigningKey(cfg.signingJwk!),
    signer: new TokenSigner(cfg.tokenSecret, cfg.issuer),
    claims,
    mailer: emailConfigured(cfg) ? mailer : null,
    ...(options.brandName ? { brandName: options.brandName } : {}),
    emailAllowed: options.emailAllowed ?? (async () => false),
    now: () => now.ms,
    onBackgroundTask: (task) => pending.push(task),
  });
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    cfg,
    claims,
    mailer,
    now,
    base: `http://127.0.0.1:${port}`,
    async settle() {
      while (pending.length) await pending.shift();
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeQuery(over: Record<string, string> = {}): URLSearchParams {
  const { challenge } = pkcePair();
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid email",
    state: "state-value",
    nonce: "nonce-value",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...over,
  });
}

export function hiddenRequestToken(html: string): string {
  const match = /name="request" value="([^"]+)"/.exec(html);
  if (!match) throw new Error("no request token in the rendered form");
  return match[1]!.replace(/&amp;/g, "&");
}

export function linkFrom(mailer: { sent: OutgoingEmail[] }): string {
  const last = mailer.sent.at(-1);
  if (!last) throw new Error("no email was sent");
  const match = /(https?:\/\/\S*\/verify#token=[^"\s<]+)/.exec(last.text);
  if (!match) throw new Error("no sign-in link in the message");
  return match[1]!;
}

export const basicAuth = (id: string, secret: string): string =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
