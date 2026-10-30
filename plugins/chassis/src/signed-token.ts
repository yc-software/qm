import { createHmac, timingSafeEqual } from "node:crypto";

export function deriveKey(secret: string, label: string): Buffer {
  return createHmac("sha256", secret).update(label).digest();
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const mac = (key: Buffer, body: string): Buffer => createHmac("sha256", key).update(body).digest();

export function seal(payload: unknown, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${mac(key, body).toString("base64url")}`;
}

export function open(
  token: string | null | undefined,
  keys: Buffer | Buffer[],
  digests: BufferEncoding[] = ["base64url"],
): Record<string, unknown> | null {
  const [body, signature, ...rest] = token?.split(".") ?? [];
  if (!body || !signature || rest.length) return null;
  const signedWith = (key: Buffer): boolean => {
    const digest = mac(key, body);
    return digests.some((encoding) => safeEqual(digest.toString(encoding), signature));
  };
  if (!(Array.isArray(keys) ? keys : [keys]).some(signedWith)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
