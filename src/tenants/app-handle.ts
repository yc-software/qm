import { z } from "zod";
import { APP_HANDLE_CHARS, DNS_LABEL_MAX, isAppHandleShape } from "../../plugins/chassis/src/dns-label.ts";

const RESERVED_APP_HANDLES = ["auth", "slack", "mt", "www", "api", "docs", "apps", "admin"] as const;

export const appHandleSchema = z
  .string()
  .refine(isAppHandleShape, `use ${APP_HANDLE_CHARS}`)
  .refine((handle) => !(RESERVED_APP_HANDLES as readonly string[]).includes(handle), "that handle is reserved");

export const APP_HOSTS_KEY = "app_hosts_pkey";

export function appHostLabel(handle: string, name: string): string {
  return `${handle}-${name}`;
}

export function appLabelLimitError(handle: string | undefined, ref: string): string | undefined {
  if (!handle) return undefined;
  const label = appHostLabel(handle, ref);
  if (label.length <= DNS_LABEL_MAX) return undefined;
  return `app "${ref}" would be served at "${label}" (${label.length} characters), over the ${DNS_LABEL_MAX}-character DNS label limit; choose a shorter app name or app handle`;
}

export function appNameFromLabel(label: string, handle: string | undefined): string | undefined {
  const prefix = handle ? `${handle}-` : undefined;
  return prefix && label.startsWith(prefix) && label.length > prefix.length ? label.slice(prefix.length) : label;
}

export function appAddressTakenError(label: string): string {
  return `the app address "${label}" is already taken by another workspace's app; choose a different app name`;
}

export function labelOfAppHost(host: string | undefined, appsDomain: string | undefined): string | undefined {
  if (!appsDomain) return undefined;
  const bare = (host ?? "").split(":")[0]!.toLowerCase();
  const suffix = `.${appsDomain.toLowerCase()}`;
  return bare.endsWith(suffix) ? bare.slice(0, -suffix.length) : undefined;
}
