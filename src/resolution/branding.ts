import type { OrgBranding, ScopedConfigStore } from "./config-store.ts";
import type { ScopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";

const LABEL_STRIP = /[\u0000-\u001F\u007F-\u009F\u2028\u2029<>{}]/g;
const ACCENT_RE = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function cleanBrandingLabel(value: unknown, cap: number): string | undefined {
  const cleaned = (typeof value === "string" ? value : "").replace(LABEL_STRIP, "").trim();
  return [...cleaned].slice(0, cap).join("") || undefined;
}

export function sanitizeBranding(raw: {
  accent?: unknown;
  mark?: unknown;
  selfLabel?: unknown;
  orgName?: unknown;
}): OrgBranding | undefined {
  const accentRaw = (typeof raw.accent === "string" ? raw.accent : "").replace(LABEL_STRIP, "").trim();
  const accent = accentRaw && ACCENT_RE.test(accentRaw) ? accentRaw : undefined;
  const markRaw = typeof raw.mark === "string" ? raw.mark.replace(/["\\]/g, "") : undefined;
  const mark = cleanBrandingLabel(markRaw, 2);
  const selfLabel = cleanBrandingLabel(raw.selfLabel, 40);
  const orgName = cleanBrandingLabel(raw.orgName, 40);
  const branding: OrgBranding = {
    ...(accent ? { accent } : {}),
    ...(mark ? { mark } : {}),
    ...(selfLabel ? { selfLabel } : {}),
    ...(orgName ? { orgName } : {}),
  };
  return Object.keys(branding).length ? branding : undefined;
}

export async function resolveBranding(
  config: Pick<ScopedConfigStore, "getBrandingDurable"> | undefined,
  orgScope: ScopeId,
  dflt?: OrgBranding,
): Promise<OrgBranding> {
  const stored = config
    ? await config.getBrandingDurable(orgScope).catch(swallowAs<OrgBranding | null>("branding: durable read", null))
    : null;
  return (
    sanitizeBranding({
      accent: stored?.accent ?? dflt?.accent,
      mark: stored?.mark ?? dflt?.mark,
      selfLabel: stored?.selfLabel ?? dflt?.selfLabel,
      orgName: stored?.orgName ?? dflt?.orgName,
    }) ?? {}
  );
}
