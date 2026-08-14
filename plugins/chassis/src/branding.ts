export interface OrgBranding {
  accent?: string;
  mark?: string;
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

export function createBrandingCache(fetchBranding: () => Promise<OrgBranding>): BrandingCache {
  let value: OrgBranding = {};
  let warmed = false;
  let nextAt = 0;
  let inflight: Promise<void> | null = null;

  const kick = (): void => {
    if (inflight || Date.now() < nextAt) return;
    inflight = (async () => {
      try {
        value = await fetchBranding();
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
  setTimeout(kick, 0);

  return {
    current: () => value,
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

const escapeAttr = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function injectBranding(html: string, branding: OrgBranding, opts?: { titleSuffix?: string }): string {
  const { accent, mark, selfLabel } = branding;
  let out = html;
  if (selfLabel) {
    out = out.replace(
      /(<meta name="brand-self-label" content=")[^"]*(")/,
      (_m, pre: string, post: string) => `${pre}${escapeAttr(selfLabel)}${post}`,
    );
    if (opts?.titleSuffix) {
      const title = escapeAttr(`${selfLabel} ${opts.titleSuffix}`);
      out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`);
    }
  }
  const decls = [...(accent ? [`--brand-accent:${accent}`] : []), ...(mark ? [`--brand-mark:"${mark}"`] : [])].join(
    ";",
  );
  if (decls) out = out.replace("</head>", () => `<style>:root{${decls}}</style></head>`);
  return out;
}
