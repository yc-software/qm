/** Deployment branding for sign-in pages, read from operator config; nothing here names an organization. */

/** A CSS hex colour from config (e.g. ORG_BRAND_ACCENT), or undefined when unset or malformed. */
export function brandAccent(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value) ? value : undefined;
}

/** Overrides the pages' accent variables; empty when no accent is configured. */
export function brandAccentStyle(accent: string | undefined): string {
  return accent ? `<style>:root{ --accent:${accent}; --on-accent:#fff; }</style>` : "";
}

/** An inline SVG mark from config (e.g. the deployment's favicon), or undefined when it isn't a plain SVG. */
export function brandMark(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || !/^<svg[\s>]/i.test(value) || !/<\/svg>$/i.test(value)) return undefined;
  return /<script|<foreignObject|\son[a-z]+\s*=|javascript:|href\s*=/i.test(value) ? undefined : value;
}
