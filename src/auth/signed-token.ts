import { createHmac } from "node:crypto";
import { CompactSign, compactVerify, decodeProtectedHeader } from "jose";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function signingKeyId(secret: string): string {
  return createHmac("sha256", secret).update("qm-signing-key-id").digest("base64url").slice(0, 8);
}

export function mintSignedPayload(value: unknown, secret: string): Promise<string> {
  return new CompactSign(encoder.encode(JSON.stringify(value)))
    .setProtectedHeader({ alg: "HS256", kid: signingKeyId(secret) })
    .sign(encoder.encode(secret));
}

export async function verifySignedPayload(token: string, secret: string | string[]): Promise<unknown | null> {
  const secrets = Array.isArray(secret) ? secret : [secret];
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
