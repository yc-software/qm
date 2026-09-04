import { createHash, createHmac } from "node:crypto";
import type { Webhook } from "../types.ts";
import { constantTimeEqual } from "../util/crypto.ts";

export interface VerifierInput {
  secret?: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export interface Verifier {
  verify(input: VerifierInput): boolean;
  deliveryId(input: VerifierInput): string;
  handshake?(input: VerifierInput, parsedBody: unknown): string | null;
}

function header(headers: VerifierInput["headers"], name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function bodyHash(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function signedBodyId(rawBody: string, field: string): string {
  try {
    const b = JSON.parse(rawBody);
    if (isObj(b) && typeof b[field] === "string") return b[field];
  } catch {
    return bodyHash(rawBody);
  }
  return bodyHash(rawBody);
}

const github: Verifier = {
  verify({ secret, headers, rawBody }) {
    if (!secret) return false;
    const sig = header(headers, "x-hub-signature-256");
    if (!sig) return false;
    return constantTimeEqual(sig, `sha256=${hmacHex(secret, rawBody)}`);
  },
  deliveryId({ rawBody }) {
    return bodyHash(rawBody);
  },
  handshake({ headers }) {
    return header(headers, "x-github-event") === "ping" ? "pong" : null;
  },
};

const SLACK_TS_TOLERANCE_SECONDS = 60 * 5;

const slack: Verifier = {
  verify({ secret, headers, rawBody }) {
    if (!secret) return false;
    const sig = header(headers, "x-slack-signature");
    const ts = header(headers, "x-slack-request-timestamp");
    if (!sig || !ts) return false;
    const tsSeconds = Number(ts);
    if (!Number.isFinite(tsSeconds)) return false;
    if (Math.abs(Date.now() / 1000 - tsSeconds) > SLACK_TS_TOLERANCE_SECONDS) return false;
    return constantTimeEqual(sig, `v0=${hmacHex(secret, `v0:${ts}:${rawBody}`)}`);
  },
  deliveryId({ rawBody }) {
    return signedBodyId(rawBody, "event_id");
  },
  handshake(_input, parsedBody) {
    if (isObj(parsedBody) && parsedBody.type === "url_verification" && typeof parsedBody.challenge === "string") {
      return parsedBody.challenge;
    }
    return null;
  },
};

const stripe: Verifier = {
  verify({ secret, headers, rawBody }) {
    if (!secret) return false;
    const sig = header(headers, "stripe-signature");
    if (!sig) return false;
    const parts = sig.split(",").map((p) => p.split("=") as [string, string]);
    const t = parts.find(([k]) => k === "t")?.[1];
    const v1s = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => v);
    if (!t || v1s.length === 0) return false;
    const expected = hmacHex(secret, `${t}.${rawBody}`);
    return v1s.some((v1) => constantTimeEqual(v1, expected));
  },
  deliveryId({ rawBody }) {
    return signedBodyId(rawBody, "id");
  },
};

const hmacSha256: Verifier = {
  verify({ secret, headers, rawBody }) {
    if (!secret) return false;
    const raw = header(headers, "x-signature");
    if (!raw) return false;
    const sig = raw.startsWith("sha256=") ? raw.slice("sha256=".length) : raw;
    return constantTimeEqual(sig, hmacHex(secret, rawBody));
  },
  deliveryId({ rawBody }) {
    return bodyHash(rawBody);
  },
};

const VERIFIERS: Record<WebhookScheme, Verifier> = { github, slack, stripe, "hmac-sha256": hmacSha256 };

export type WebhookScheme = Webhook["verification"]["scheme"];

export const WEBHOOK_SCHEMES = Object.keys(VERIFIERS) as readonly WebhookScheme[];

export function getVerifier(scheme: string): Verifier | null {
  return (VERIFIERS as Partial<Record<string, Verifier>>)[scheme] ?? null;
}
