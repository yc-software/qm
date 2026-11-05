import { parseArgs } from "node:util";
import { orgId } from "../config.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { scopeId } from "../types.ts";
import { isTenantId, withTenant } from "./context.ts";
import { TENANT_SETTING_KEYS, tenantSettingsSchema, type TenantSettings } from "./settings.ts";

type Db = Pick<PgPool, "q">;

const TENANT_USAGE = `usage:
  qm tenant create [--brand-name <name>]          create a tenant and print its id
  qm tenant list                                  list tenants
  qm tenant settings set <tenant> <key> <json>    set one setting (null removes it); keys: ${TENANT_SETTING_KEYS.join(", ")}
  qm tenant members add <tenant> <email> [--admin]
                                                  add a member to the tenant's directory, optionally as org admin`;

export class TenantCommandError extends Error {}

async function createTenant(db: Db, settings: TenantSettings = {}): Promise<string> {
  const parsed = tenantSettingsSchema.safeParse(settings);
  if (!parsed.success)
    throw new TenantCommandError(`invalid settings: ${parsed.error.issues[0]?.message ?? "rejected"}`);
  const rows = await db.q("INSERT INTO tenants (settings) VALUES ($1::jsonb) RETURNING id::text AS id", [
    JSON.stringify(parsed.data),
  ]);
  return rows[0]!.id as string;
}

async function listTenants(db: Db): Promise<{ id: string; createdAt: string; brandName?: string }[]> {
  const rows = await db.q(
    "SELECT id::text AS id, created_at, settings->>'brandName' AS brand_name FROM tenants ORDER BY created_at, id",
  );
  return rows.map((r) => ({
    id: r.id as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    ...(r.brand_name ? { brandName: r.brand_name as string } : {}),
  }));
}

function settingValue(key: string, json: string): unknown {
  if (!(TENANT_SETTING_KEYS as string[]).includes(key))
    throw new TenantCommandError(`unknown setting ${key}; expected one of ${TENANT_SETTING_KEYS.join(", ")}`);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new TenantCommandError(`the value for ${key} is not valid JSON`);
  }
  if (value === null) return null;
  const parsed = tenantSettingsSchema.safeParse({ [key]: value });
  if (!parsed.success) throw new TenantCommandError(`invalid ${key}: ${parsed.error.issues[0]?.message ?? "rejected"}`);
  return parsed.data[key as keyof TenantSettings];
}

function tenantArg(tenant: string | undefined): string {
  if (!isTenantId(tenant)) throw new TenantCommandError("expected a tenant id");
  return tenant;
}

async function setTenantSetting(db: Db, tenant: string, key: string, json: string): Promise<void> {
  const value = settingValue(key, json);
  const rows = await withTenant(tenantArg(tenant), () =>
    value === null
      ? db.q("UPDATE tenants SET settings = settings - $1 WHERE id = qm_bound_tenant() RETURNING id", [key])
      : db.q(
          "UPDATE tenants SET settings = settings || jsonb_build_object($1::text, $2::jsonb) WHERE id = qm_bound_tenant() RETURNING id",
          [key, JSON.stringify(value)],
        ),
  );
  if (!rows.length) throw new TenantCommandError(`no tenant ${tenant}`);
}

async function addTenantMember(db: Db, tenant: string, email: string, admin: boolean): Promise<void> {
  const principal = email.trim().toLowerCase();
  if (!/^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(principal) || principal.length > 254)
    throw new TenantCommandError("expected an email address");
  const org = orgId();
  await withTenant(tenantArg(tenant), async () => {
    if (!(await db.q("SELECT 1 FROM tenants WHERE id = qm_bound_tenant()")).length)
      throw new TenantCommandError(`no tenant ${tenant}`);
    await db.q(
      `INSERT INTO directory_members (org_id, principal_id, display_name, display_name_lc, type)
       VALUES ($1, $2, $2, $2, 'internal')
       ON CONFLICT (tenant_id, org_id, principal_id) DO UPDATE SET type = 'internal'`,
      [org, principal],
    );
    if (admin)
      await db.q(
        `INSERT INTO admin_grants (principal_id, scope_id, role, created_at) VALUES ($1, $2, 'org_admin', $3)
         ON CONFLICT (tenant_id, principal_id, scope_id, role) DO NOTHING`,
        [principal, scopeId("org", org), Date.now()],
      );
  });
}

function parsedArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: { "brand-name": { type: "string" }, admin: { type: "boolean" } },
    });
  } catch (e) {
    throw new TenantCommandError(`${e instanceof Error ? e.message : String(e)}\n${TENANT_USAGE}`);
  }
}

export async function runTenantCommand(db: Db, args: string[], print: (line: string) => void): Promise<void> {
  const { positionals, values } = parsedArgs(args);
  const [command, sub, ...rest] = positionals;
  if (command === "create" && sub === undefined) {
    const brandName = values["brand-name"];
    return print(await createTenant(db, brandName === undefined ? {} : { brandName }));
  }
  if (command === "list" && sub === undefined) {
    for (const t of await listTenants(db)) print([t.id, t.createdAt, t.brandName ?? ""].join("\t"));
    return;
  }
  if (command === "settings" && sub === "set" && rest.length === 3)
    return setTenantSetting(db, rest[0]!, rest[1]!, rest[2]!);
  if (command === "members" && sub === "add" && rest.length === 2)
    return addTenantMember(db, rest[0]!, rest[1]!, values.admin === true);
  throw new TenantCommandError(TENANT_USAGE);
}
