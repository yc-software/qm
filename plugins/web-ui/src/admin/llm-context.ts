import { html } from "lit";
import { metaChip } from "./shared.ts";
import { fmtPct, fmtTokens } from "./format.ts";

type Row = Record<string, any>;

export interface CacheUsage {
  cacheRead: number;
  cacheWrite: number;
  uncachedInput: number;
}

export function transportText(transport: Row | null | undefined) {
  if (!transport || typeof transport !== "object") return "";
  const lines = [];
  if (transport.modelId) lines.push("model: " + transport.modelId);
  const h = transport.headers;
  if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) lines.push(k + ": " + v);
  if (!lines.length) return "";
  return (
    lines.join("\n") +
    "\n\n(auth + anthropic-version headers are added by the provider SDK below the capture point, so they aren't shown)"
  );
}

function callCacheUsage(q: Row | null | undefined): CacheUsage | null {
  const u = q && q.usage;
  if (!u || typeof u !== "object") return null;
  return {
    cacheRead: Number(u.cacheRead) || 0,
    cacheWrite: Number(u.cacheWrite) || 0,
    uncachedInput: Number(u.input) || 0,
  };
}

export function sumCacheUsage(requests: Row[] | null | undefined): CacheUsage | null {
  const usages = (requests || []).map(callCacheUsage).filter((u): u is CacheUsage => !!u);
  const sum = (key: keyof CacheUsage) => usages.reduce((n, u) => n + u[key], 0);
  return usages.length
    ? { cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), uncachedInput: sum("uncachedInput") }
    : null;
}

const usageTotal = (u: CacheUsage) => u.cacheRead + u.cacheWrite + u.uncachedInput;

export function fmtContextSize(q: Row | null | undefined) {
  const u = callCacheUsage(q);
  return u && usageTotal(u) > 0 ? fmtTokens(usageTotal(u)) : "? tokens";
}

const cacheHitRatio = (u: CacheUsage | null | undefined) =>
  u && usageTotal(u) > 0 ? u.cacheRead / usageTotal(u) : null;

export function isStablePrefixMiss(u: CacheUsage | null | undefined) {
  const ratio = cacheHitRatio(u);
  return ratio !== null && u!.cacheWrite >= 1024 && ratio < 0.1;
}

export function cacheMetaItems(u: CacheUsage | null | undefined) {
  if (!u) return [];
  const ratio = cacheHitRatio(u);
  const miss = isStablePrefixMiss(u);
  const out = [metaChip("cache " + (ratio === null ? "n/a" : fmtPct(ratio)), miss ? "danger" : "")];
  if (miss) out.push(metaChip("stable-prefix miss", "danger"));
  return out;
}

export function rawJsonLink(requests: Row[], label = "Raw JSON") {
  let payload: unknown = requests.map((q) => ({
    step: q.step,
    model: q.model,
    createdAt: q.createdAt,
    ...(q.usage ? { usage: q.usage } : {}),
    ...(q.transport ? { transport: q.transport } : {}),
  }));
  if (requests.length === 1) payload = (payload as unknown[])[0];
  let url: string | null = null;
  const open = (e: Event) => {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    (e.currentTarget as HTMLAnchorElement).href = url;
  };
  return html`<a class="context-raw" href="#" target="_blank" rel="noopener" @click=${open}>${label}</a>`;
}
