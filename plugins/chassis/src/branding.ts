import { boundTenant } from "./tenant.ts";
export interface OrgBranding {
  orgName?: string;
  accent?: string;
  mark?: string;
  markUrl?: string;
  selfLabel?: string;
}

const REFRESH_MS = 30_000;
const RETRY_MS = 5_000;
const FIRST_RENDER_WAIT_MS = 1_500;

export interface BrandingCache {
  current(): OrgBranding;
  forRender(): Promise<OrgBranding>;
  refreshNow(): Promise<void>;
}

interface BrandingState {
  value: OrgBranding;
  warmed: boolean;
  nextAt: number;
  inflight: Promise<void> | null;
}

export function createBrandingCache(fetchBranding: () => Promise<OrgBranding>): BrandingCache {
  const states = new Map<string, BrandingState>();
  const state = (): BrandingState => {
    const key = boundTenant() ?? "";
    const existing = states.get(key);
    if (existing) return existing;
    const fresh: BrandingState = { value: {}, warmed: false, nextAt: 0, inflight: null };
    states.set(key, fresh);
    return fresh;
  };

  const kick = (current: BrandingState): void => {
    if (current.inflight || Date.now() < current.nextAt) return;
    current.inflight = (async () => {
      try {
        current.value = await fetchBranding();
        if (process.env.BRANDING_DEBUG) console.error("[branding] fetched:", JSON.stringify(current.value));
        current.warmed = true;
        current.nextAt = Date.now() + REFRESH_MS;
      } catch (err) {
        if (process.env.BRANDING_DEBUG) console.error("[branding] fetch failed:", String(err));
        current.nextAt = Date.now() + RETRY_MS;
      } finally {
        current.inflight = null;
      }
    })();
  };
  setTimeout(() => kick(state()), 0);

  return {
    current: () => state().value,
    async forRender(): Promise<OrgBranding> {
      const current = state();
      kick(current);
      if (!current.warmed && current.inflight) {
        await Promise.race([current.inflight, new Promise((r) => setTimeout(r, FIRST_RENDER_WAIT_MS))]);
      }
      return current.value;
    },
    async refreshNow(): Promise<void> {
      const current = state();
      if (current.inflight) await current.inflight;
      current.nextAt = 0;
      kick(current);
      if (current.inflight) await current.inflight;
    },
  };
}

const escapeAttr = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CSS_HOSTILE = /[<>{}"'();\\]/;
const cssSafe = (v: string | undefined): v is string => !!v && !CSS_HOSTILE.test(v);
const cssUrlSafe = (v: string | undefined): v is string => cssSafe(v) && /^https:\/\/\S+$/.test(v);

export function injectBranding(html: string, branding: OrgBranding, opts?: { titleSuffix?: string }): string {
  const { accent, mark, markUrl, selfLabel } = branding;
  let out = html;
  if (selfLabel) {
    out = out.replace(
      /(<meta name="brand-self-label" content=")[^"]*(")/,
      (_m, pre: string, post: string) => `${pre}${escapeAttr(selfLabel)}${post}`,
    );
    out = out.replace(
      /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/,
      (_m, pre: string, post: string) => `${pre}${escapeAttr(selfLabel)}${post}`,
    );
    if (opts?.titleSuffix) {
      const title = escapeAttr(`${selfLabel} ${opts.titleSuffix}`);
      out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`);
    }
  }
  const decls = [
    ...(cssSafe(accent) ? [`--brand-accent:${accent}`] : []),
    ...(cssSafe(mark) ? [`--brand-mark:"${mark}"`] : []),
    ...(cssUrlSafe(markUrl) ? [`--brand-mark-image:url("${markUrl}")`] : []),
  ].join(";");
  if (decls) out = out.replace("</head>", () => `<style>:root{${decls}}</style></head>`);
  return out;
}
