import { z } from "zod";
import { APP_HANDLE_CHARS, DNS_LABEL_MAX, isAppHandleShape } from "../../plugins/chassis/src/dns-label.ts";

const RESERVED_APP_HANDLES = ["auth", "slack", "mt", "www", "api", "docs", "apps", "admin"] as const;

export const appHandleSchema = z
  .string()
  .refine(isAppHandleShape, `use ${APP_HANDLE_CHARS}`)
  .refine((handle) => !(RESERVED_APP_HANDLES as readonly string[]).includes(handle), "that handle is reserved");

export function appHostLabel(handle: string, name: string): string {
  return `${handle}-${name}`;
}

export function splitAppLabel(label: string): { handle: string; name: string } | undefined {
  const dash = label.indexOf("-");
  if (dash < 1 || dash === label.length - 1 || label.includes(".")) return undefined;
  return { handle: label.slice(0, dash), name: label.slice(dash + 1) };
}

export function appLabelLimitError(handle: string | undefined, ref: string): string | undefined {
  if (!handle) return undefined;
  const label = appHostLabel(handle, ref);
  if (label.length <= DNS_LABEL_MAX) return undefined;
  return `app "${ref}" would be served at "${label}" (${label.length} characters), over the ${DNS_LABEL_MAX}-character DNS label limit; choose a shorter app name or app handle`;
}

export function appNameFromLabel(label: string, handle: string | undefined): string | undefined {
  if (!handle) return label;
  const split = splitAppLabel(label);
  return split?.handle === handle ? split.name : label;
}

export function labelOfAppHost(host: string | undefined, appsDomain: string | undefined): string | undefined {
  if (!appsDomain) return undefined;
  const bare = (host ?? "").split(":")[0]!.toLowerCase();
  const suffix = `.${appsDomain.toLowerCase()}`;
  return bare.endsWith(suffix) ? bare.slice(0, -suffix.length) : undefined;
}
