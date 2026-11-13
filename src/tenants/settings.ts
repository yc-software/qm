import { z } from "zod";
import type { PgPool } from "../persistence/pg-pool.ts";
import { loadTenant, perTenant } from "./cache.ts";
import { boundTenant } from "./context.ts";
import { appHandleSchema, appLabelLimitError } from "./app-handle.ts";
import { SCOPE_KINDS } from "../types.ts";
import { isDnsLabel } from "../../plugins/chassis/src/dns-label.ts";

const text = z.string().min(1);

const sandboxBackend = z.enum(["sprites", "modal", "superserve"]);

const namePrefix = z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/, "expected a lowercase sandbox name prefix");

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
    orgSlug: z.string().refine(isDnsLabel, "expected a lowercase org slug"),
    handle: appHandleSchema,
    slackBridgeToken: z.string().regex(/^[\x21-\x7e]{16,}$/, "expected a Slack service bridge token"),
    genericChatAccount: text,
    spritesToken: text,
    spritesNamePrefix: namePrefix,
    modalAppName: text,
    modalEnvironment: text,
    modalNamePrefix: namePrefix,
    superserveApiKey: text,
    superserveTemplate: text,
    superserveNamePrefix: namePrefix,
    sandboxBackend,
    sandboxScopeBackends: z.partialRecord(z.enum(SCOPE_KINDS), sandboxBackend),
    serving: z.boolean(),
  })
  .partial()
  .strict();

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const TENANT_SETTING_KEYS = Object.keys(tenantSettingsSchema.shape) as (keyof TenantSettings)[];

export const TENANT_SETTINGS_REFRESH_MS = 30_000;

const loaded = perTenant<{ settings?: TenantSettings; handle?: string }>(() => ({}));

export async function loadTenantSettings(db: Pick<PgPool, "q">): Promise<void> {
  const rows = await db.q(
    `SELECT settings, qm_tenant_handle(settings) AS handle FROM tenants WHERE id = qm_bound_tenant()`,
  );
  const state = loaded();
  state.settings = tenantSettingsSchema.parse(rows[0]?.settings ?? {});
  state.handle = typeof rows[0]?.handle === "string" ? rows[0].handle : undefined;
}

export function tenantAppHandle(): string | undefined {
  return boundTenant() === undefined ? undefined : loaded().handle;
}

export function assertAppLabelFits(ref: string): void {
  const problem = appLabelLimitError(tenantAppHandle(), ref);
  if (problem) throw new Error(problem);
}

export function noteTenantAppHandle(handle: string): void {
  loaded().handle = handle;
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
