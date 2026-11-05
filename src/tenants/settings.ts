import { z } from "zod";
import type { PgPool } from "../persistence/pg-pool.ts";
import { loadTenant, perTenant } from "./cache.ts";
import { boundTenant } from "./context.ts";

const text = z.string().min(1);

const emailOrDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^@\s,;<>"]*@[^@\s,;<>"]+\.[^@\s,;<>"]+$/, "expected an email address or @domain");

export const tenantSettingsSchema = z
  .object({
    oidcClient: z.object({ clientId: text, clientSecret: text.optional() }).strict(),
    allowedEmails: z.array(emailOrDomain),
    brandName: z.string().trim().min(1),
    modelGatewayKey: text,
    orgSlug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "expected a lowercase org slug"),
    slackBridgeToken: z.string().regex(/^[\x21-\x7e]{16,}$/, "expected a Slack service bridge token"),
  })
  .partial()
  .strict();

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const TENANT_SETTING_KEYS = Object.keys(tenantSettingsSchema.shape) as (keyof TenantSettings)[];

export const TENANT_SETTINGS_REFRESH_MS = 30_000;

const loaded = perTenant<{ settings?: TenantSettings; host?: string }>(() => ({}));

export async function loadTenantSettings(db: Pick<PgPool, "q">): Promise<void> {
  const rows = await db.q(
    `SELECT settings, (SELECT host FROM tenant_hosts WHERE tenant_id = qm_bound_tenant()
      ORDER BY length(host), host LIMIT 1) AS host FROM tenants WHERE id = qm_bound_tenant()`,
  );
  const state = loaded();
  state.settings = tenantSettingsSchema.parse(rows[0]?.settings ?? {});
  state.host = typeof rows[0]?.host === "string" ? rows[0].host : undefined;
}

export function tenantHost(): string | undefined {
  return boundTenant() === undefined ? undefined : loaded().host;
}

export function tenantSettings(): TenantSettings {
  return loaded().settings ?? {};
}

export function loadedTenantSettings(): TenantSettings | undefined {
  return loaded().settings;
}

export async function tenantAllowsEmail(email: string): Promise<boolean | undefined> {
  await loadTenant();
  const allowed = tenantSettings().allowedEmails;
  if (!allowed) return undefined;
  const normalized = email.trim().toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf("@"));
  return allowed.some((entry) => entry === normalized || (entry.startsWith("@") && entry === domain));
}
