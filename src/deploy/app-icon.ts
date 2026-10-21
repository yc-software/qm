const DEFAULT_ICONS = ["🚀", "🧭", "🛠️", "📊", "🧪", "🌱", "🎯", "📦", "🔭", "🧩", "⚡", "🗺️", "🪄", "📚", "🎨", "🛰️"];

export const APP_ICON_HINT = "a single emoji";

export function defaultAppIcon(seed: string): string {
  let hash = 2166136261;
  for (const ch of seed) hash = Math.imul(hash ^ ch.codePointAt(0)!, 16777619);
  return DEFAULT_ICONS[(hash >>> 0) % DEFAULT_ICONS.length]!;
}

export function parseAppIcon(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const icon = value.trim();
  if (!icon || icon.length > 32) return null;
  if ([...new Intl.Segmenter().segment(icon)].length !== 1) return null;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(icon) ? icon : null;
}

export function appIconOf(d: { icon?: string; name?: string; id: string }): string {
  return d.icon ?? defaultAppIcon(d.name ?? d.id);
}

export function appIconHref(icon: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90" text-anchor="middle" x="50">${icon}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
