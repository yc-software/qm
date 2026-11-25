import { createHash } from "node:crypto";

export interface PrincipalLinkResolver {
  canonical(key: string): string | undefined;
  aliases(key: string): readonly string[];
  userId(key: string): string | undefined;
}

export const USER_ID_NAMESPACE = "8f0b6a52-3c1e-5d7a-9b4e-2f6c1d8a7e30";

let links: PrincipalLinkResolver | null = null;

export function installPrincipalLinks(resolver: PrincipalLinkResolver | null): void {
  links = resolver;
}

export function principalLinks(): PrincipalLinkResolver | null {
  return links;
}

export function foldPrincipalId(id: string | null | undefined): string {
  const s = (id ?? "").trim();
  return s.includes("@") ? s.toLowerCase() : s;
}

const HEX = "0123456789abcdef";

function isUuid(id: string): boolean {
  return (
    id.length === 36 &&
    [...id.toLowerCase()].every((ch, i) => ([8, 13, 18, 23].includes(i) ? ch === "-" : HEX.includes(ch)))
  );
}

const founded = new Map<string, string>();

export function foundingUserId(alias: string): string {
  const key = foldPrincipalId(alias);
  const bytes = createHash("md5")
    .update(Buffer.from(USER_ID_NAMESPACE.replaceAll("-", ""), "hex"))
    .update(key)
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x30;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  founded.set(id, key);
  return id;
}

export function personUserId(id: string): string {
  const key = foldPrincipalId(id);
  if (!key) return key;
  const linked = links?.userId(key);
  if (linked) return linked;
  return isUuid(key) ? key.toLowerCase() : foundingUserId(links?.canonical(key) ?? key);
}

export function userPerson(userId: string): string {
  return links?.canonical(userId) ?? founded.get(userId) ?? userId;
}
