import { boundTenant, withTenant } from "./tenant.ts";
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

function tenantBranding(tenant: string, fetchBranding: () => Promise<OrgBranding>): BrandingCache {
  let value: OrgBranding = {};
  let warmed = false;
  let nextAt = 0;
  let inflight: Promise<void> | null = null;

  const kick = (): void => {
    if (inflight || Date.now() < nextAt) return;
    inflight = (async () => {
      try {
        value = await withTenant(tenant, fetchBranding);
        if (process.env.BRANDING_DEBUG) console.error("[branding] fetched:", JSON.stringify(value));
        warmed = true;
        nextAt = Date.now() + REFRESH_MS;
      } catch (err) {
        if (process.env.BRANDING_DEBUG) console.error("[branding] fetch failed:", String(err));
        nextAt = Date.now() + RETRY_MS;
      } finally {
        inflight = null;
      }
    })();
  };

  return {
    current: () => {
      kick();
      return value;
    },
    async forRender(): Promise<OrgBranding> {
      kick();
      if (!warmed && inflight) {
        await Promise.race([inflight, new Promise((r) => setTimeout(r, FIRST_RENDER_WAIT_MS))]);
      }
      return value;
    },
    async refreshNow(): Promise<void> {
      if (inflight) await inflight;
      nextAt = 0;
      kick();
      if (inflight) await inflight;
    },
  };
}

export function createBrandingCache(fetchBranding: () => Promise<OrgBranding>): BrandingCache {
  const tenants = new Map<string, BrandingCache>();
  const forTenant = (): BrandingCache | undefined => {
    const tenant = boundTenant();
    if (!tenant) return undefined;
    const cache = tenants.get(tenant) ?? tenantBranding(tenant, fetchBranding);
    tenants.set(tenant, cache);
    return cache;
  };
  return {
    current: () => forTenant()?.current() ?? {},
    forRender: async () => (await forTenant()?.forRender()) ?? {},
    refreshNow: async () => forTenant()?.refreshNow(),
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
