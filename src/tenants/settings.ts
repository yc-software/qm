import { z } from "zod";
import type { PgPool } from "../persistence/pg-pool.ts";
import { loadTenant, perTenant } from "./cache.ts";

const text = z.string().min(1).max(4096);

const emailOrDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^@\s,;<>"]*@[^@\s,;<>"]+\.[^@\s,;<>"]+$/, "expected an email address or @domain");

export const tenantSettingsSchema = z
  .object({
    oidcClient: z.object({ clientId: text, clientSecret: text.optional() }).strict(),
    allowedEmails: z.array(emailOrDomain).max(10_000),
    brandName: z.string().trim().min(1).max(40),
    modelGatewayKey: text,
    orgSlug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "expected a lowercase org slug"),
    slackBridgeToken: z.string().regex(/^[\x21-\x7e]{16,512}$/, "expected a Slack service bridge token"),
  })
  .partial()
  .strict();

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const TENANT_SETTING_KEYS = Object.keys(tenantSettingsSchema.shape) as (keyof TenantSettings)[];

export const TENANT_SETTINGS_REFRESH_MS = 30_000;

const loaded = perTenant<{ settings?: TenantSettings }>(() => ({}));

export async function loadTenantSettings(db: Pick<PgPool, "q">): Promise<void> {
  const rows = await db.q("SELECT settings FROM tenants WHERE id = qm_bound_tenant()");
  loaded().settings = tenantSettingsSchema.parse(rows[0]?.settings ?? {});
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
