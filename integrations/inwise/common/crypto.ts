import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { EncryptedEnvelope } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";

export interface EncodedKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateEncodedKeyPair(): EncodedKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    privateKey: privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64url"),
  };
}

export function derivePairingKey(
  privateKey: string,
  peerPublicKey: string,
  pairingId: string,
): Buffer {
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: Buffer.from(privateKey, "base64url"),
      type: "pkcs8",
      format: "der",
    }),
    publicKey: createPublicKey({
      key: Buffer.from(peerPublicKey, "base64url"),
      type: "spki",
      format: "der",
    }),
  });
  return Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.from(pairingId, "utf8"),
      Buffer.from("inwise-qm-v1", "utf8"),
      32,
    ),
  );
}

export function encryptJson(
  key: Buffer,
  value: unknown,
  associatedData: string,
): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    version: PROTOCOL_VERSION,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptJson<T>(
  key: Buffer,
  envelope: EncryptedEnvelope,
  associatedData: string,
): T {
  if (envelope.version !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported envelope version: ${String(envelope.version)}`,
    );
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function requestAad(pairingId: string, requestId: string): string {
  return `${pairingId}:${requestId}:request`;
}

export function responseAad(pairingId: string, requestId: string): string {
  return `${pairingId}:${requestId}:response`;
}

export function pairingVerificationCode(
  key: Buffer,
  pairingId: string,
): string {
  const value = createHmac("sha256", key)
    .update(`inwise-qm-verify:${pairingId}`, "utf8")
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
}
