import { createHash, createHmac } from "node:crypto";
import { CompactSign, compactVerify, decodeProtectedHeader } from "jose";
import { constantTimeEqual } from "../util/crypto.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function signingKeyId(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url").slice(0, 8);
}

export function mintSignedPayload(value: unknown, secret: string): Promise<string> {
  return new CompactSign(encoder.encode(JSON.stringify(value)))
    .setProtectedHeader({ alg: "HS256", kid: signingKeyId(secret) })
    .sign(encoder.encode(secret));
}

function verifyLegacyPayload(token: string, secrets: string[]): unknown | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  for (const secret of secrets) {
    const hmac = createHmac("sha256", secret).update(payload).digest();
    if (!constantTimeEqual(hmac.toString("base64url"), sig) && !constantTimeEqual(hmac.toString("hex"), sig)) continue;
    try {
      return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

export async function verifySignedPayload(token: string, secret: string | string[]): Promise<unknown | null> {
  const secrets = Array.isArray(secret) ? secret : [secret];
  if (token.split(".").length !== 3) return verifyLegacyPayload(token, secrets);
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    return null;
  }
  const ordered =
    kid === undefined
      ? secrets
      : [...secrets].sort((a, b) => Number(signingKeyId(b) === kid) - Number(signingKeyId(a) === kid));
  for (const candidate of ordered) {
    try {
      const { payload } = await compactVerify(token, encoder.encode(candidate), { algorithms: ["HS256"] });
      return JSON.parse(decoder.decode(payload)) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}
