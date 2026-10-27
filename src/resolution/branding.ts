import type { OrgBranding, ScopedConfigStore } from "./config-store.ts";
import type { ScopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";

const LABEL_STRIP = /[\u0000-\u001F\u007F-\u009F\u2028\u2029<>{}]/g;
const ACCENT_RE = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MARK_URL_RE = /^https:\/\/[^\s"'()\\;]+$/;
const MARK_BADGE_GRAPHEMES = 2;
const graphemes = new Intl.Segmenter();

export function cleanBrandingLabel(value: unknown): string | undefined {
  return (typeof value === "string" ? value : "").replace(LABEL_STRIP, "").trim() || undefined;
}

function cleanBrandingMarkUrl(value: unknown): string | undefined {
  const cleaned = cleanBrandingLabel(value);
  return cleaned && MARK_URL_RE.test(cleaned) ? cleaned : undefined;
}

export function sanitizeBranding(raw: {
  accent?: unknown;
  mark?: unknown;
  markUrl?: unknown;
  selfLabel?: unknown;
  orgName?: unknown;
}): OrgBranding | undefined {
  const accentRaw = (typeof raw.accent === "string" ? raw.accent : "").replace(LABEL_STRIP, "").trim();
  const accent = accentRaw && ACCENT_RE.test(accentRaw) ? accentRaw : undefined;
  const markRaw = typeof raw.mark === "string" ? raw.mark.replace(/["\\]/g, "") : undefined;
  const mark =
    [...graphemes.segment(cleanBrandingLabel(markRaw) ?? "")]
      .slice(0, MARK_BADGE_GRAPHEMES)
      .map((g) => g.segment)
      .join("") || undefined;
  const markUrl = cleanBrandingMarkUrl(raw.markUrl);
  const selfLabel = cleanBrandingLabel(raw.selfLabel);
  const orgName = cleanBrandingLabel(raw.orgName);
  const branding: OrgBranding = {
    ...(accent ? { accent } : {}),
    ...(mark ? { mark } : {}),
    ...(markUrl ? { markUrl } : {}),
    ...(selfLabel ? { selfLabel } : {}),
    ...(orgName ? { orgName } : {}),
  };
  return Object.keys(branding).length ? branding : undefined;
}

export async function resolveBranding(
  config: Pick<ScopedConfigStore, "settingDurable"> | undefined,
  orgScope: ScopeId,
  dflt?: OrgBranding,
): Promise<OrgBranding> {
  const stored = config
    ? await config
        .settingDurable("branding", orgScope)
        .catch(swallowAs<OrgBranding | null>("branding: durable read", null))
    : null;
  return (
    sanitizeBranding({
      accent: stored?.accent ?? dflt?.accent,
      mark: stored?.mark ?? dflt?.mark,
      markUrl: stored?.markUrl ?? dflt?.markUrl,
      selfLabel: stored?.selfLabel ?? dflt?.selfLabel,
      orgName: stored?.orgName ?? dflt?.orgName,
    }) ?? {}
  );
}
