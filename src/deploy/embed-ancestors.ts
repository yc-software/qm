const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const EMBED_ANCESTOR = new RegExp(`^https://(?:\\*\\.)?(?:${HOST_LABEL}\\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$`);
const MAX_EMBED_ANCESTORS = 16;

export const EMBED_ANCESTORS_HINT = `array of up to ${MAX_EMBED_ANCESTORS} https origins, e.g. https://tools.example.com or https://*.example.com`;

export function parseEmbedAncestors(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > MAX_EMBED_ANCESTORS) return null;
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") return null;
    const value = raw.trim().toLowerCase();
    if (!EMBED_ANCESTOR.test(value)) return null;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}
