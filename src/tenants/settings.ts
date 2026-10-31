import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { PgPool } from "../persistence/pg-pool.ts";
import { createSweeper } from "../util/sweeper.ts";
import { currentTenant, onFirstBind, withTenant } from "./context.ts";
import { reportFailureAs } from "../util/errors.ts";
import { parseTenantSettings, type TenantSettings } from "./settings-parse.ts";
import { TENANCY_BASE, TENANT, TENANT_SETTINGS_MIGRATION } from "./migrations.ts";

export type { TenantSettings } from "./settings-parse.ts";

export const TENANT_SETTING_KEYS = [
  "MODEL_PROVIDER",
  "PI_MODEL",
  "PI_DETECT_MODEL",
  "PI_TITLE_MODEL",
  "PI_JUDGE_MODEL",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENROUTER_BASE_URL",
  "MODEL_GATEWAY_URL",
  "MODEL_GATEWAY_API_KEY",
  "MODEL_GATEWAY_API_KEY_HEADER",
  "MODEL_GATEWAY_MODELS",
  "CODEX_AUTH_CREDENTIAL",
  "CLAUDE_AUTH_CREDENTIAL",
  "SANDBOX_BACKEND",
  "SPRITES_TOKEN",
  "E2B_API_KEY",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "DO_AGENTS_API_TOKEN",
  "SMOLMACHINES_TOKEN",
  "AGENT37_API_KEY",
  "SUPERSERVE_API_KEY",
  "RENDER_SANDBOX_API_KEY",
  "RENDER_SANDBOX_WORKSPACE_ID",
  "SECURITY_SCREEN",
  "SECURITY_SCREEN_CLASSIFIER",
  "SECURITY_SCREEN_PROXY_PROVIDER",
  "SECURITY_SCREEN_PROXY_ENDPOINT",
  "SECURITY_SCREEN_PROXY_TOKEN",
  "AUTH_ALLOWED_EMAILS",
  "AUTH_ALLOWED_EMAIL_DOMAIN",
  "TRUSTED_OIDC_ADMIN_ISSUER",
  "SUGGESTED_ACTIVITIES_CONTEXT",
  "ADMIN_GRANTS",
  "OIDC_ISSUER",
  "OIDC_AUTH_ENDPOINT",
  "OIDC_TOKEN_ENDPOINT",
  "OIDC_USERINFO_ENDPOINT",
  "OIDC_JWKS_URI",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_SCOPES",
  "OIDC_PROMPT",
  "OIDC_PRINCIPAL_CLAIM",
  "OIDC_ALLOWED_EMAIL_DOMAIN",
  "OIDC_ALLOWED_EMAILS",
  "PORTAL_EXPECTED_TEAM_ID",
] as const;

export const PLUGIN_SETTING_KEYS: readonly TenantSettingKey[] = [
  "OIDC_ISSUER",
  "OIDC_AUTH_ENDPOINT",
  "OIDC_TOKEN_ENDPOINT",
  "OIDC_USERINFO_ENDPOINT",
  "OIDC_JWKS_URI",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_SCOPES",
  "OIDC_PROMPT",
  "OIDC_PRINCIPAL_CLAIM",
  "OIDC_ALLOWED_EMAIL_DOMAIN",
  "OIDC_ALLOWED_EMAILS",
  "PORTAL_EXPECTED_TEAM_ID",
];

export type TenantSettingKey = (typeof TENANT_SETTING_KEYS)[number];
export type TenantSettingValues = Partial<Record<TenantSettingKey, string>>;
export type TenantSettingChanges = Partial<Record<TenantSettingKey, string | null>>;

export const TENANT_SECRET_KEYS: ReadonlySet<TenantSettingKey> = new Set<TenantSettingKey>([
  "MODEL_GATEWAY_API_KEY",
  "SPRITES_TOKEN",
  "E2B_API_KEY",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "DO_AGENTS_API_TOKEN",
  "SMOLMACHINES_TOKEN",
  "AGENT37_API_KEY",
  "SUPERSERVE_API_KEY",
  "RENDER_SANDBOX_API_KEY",
  "SECURITY_SCREEN_PROXY_TOKEN",
  "OIDC_CLIENT_SECRET",
]);

export function isTenantSettingKey(key: string): key is TenantSettingKey {
  return (TENANT_SETTING_KEYS as readonly string[]).includes(key);
}

export function tenantSettingColumn(key: TenantSettingKey): string {
  return key.toLowerCase();
}

export class TenantSettingMissingError extends Error {
  readonly status = 503;
  readonly key: string;
  constructor(key: string) {
    super(`${key} is not set in this tenant's settings`);
    this.name = "TenantSettingMissingError";
    this.key = key;
  }
}

export function requireTenantSetting(settings: TenantSettings, key: TenantSettingKey): string {
  const value = settings.values[key];
  if (!value) throw new TenantSettingMissingError(key);
  return value;
}

const SEAL_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function tenantSettingsKey(material: string | Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", material, "qm.tenant-settings", "tenant-settings.v1", 32));
}

function associatedData(tenant: string, key: TenantSettingKey): Buffer {
  return Buffer.from(`tenant_settings:${tenant}:${key}`, "utf8");
}

export function sealTenantSecret(sealKey: Buffer, tenant: string, key: TenantSettingKey, plain: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", sealKey, iv);
  cipher.setAAD(associatedData(tenant, key));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([SEAL_VERSION]), iv, cipher.getAuthTag(), body]);
}

export function openTenantSecret(sealKey: Buffer, tenant: string, key: TenantSettingKey, sealed: Buffer): string {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== SEAL_VERSION)
    throw new Error(`${key} in this tenant's settings is not a sealed value`);
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", sealKey, iv);
  decipher.setAAD(associatedData(tenant, key));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}

interface TenantSettingsBacking {
  tenants(): Promise<string[]>;
  tenantForSlug(slug: string): Promise<string | null>;
  read(tenant: string): Promise<TenantSettingValues>;
  write(tenant: string, changes: TenantSettingChanges): Promise<void>;
}

function postgresBacking(db: PgPool, keyMaterial: string | Buffer): TenantSettingsBacking {
  db.registerMigration(TENANCY_BASE);
  db.registerMigration(TENANT_SETTINGS_MIGRATION);
  let migrated: Promise<void> | null = null;
  const q = async (text: string, params?: unknown[]) => {
    migrated ??= db
      .migrate(TENANCY_BASE)
      .then(() => db.migrate(TENANT_SETTINGS_MIGRATION))
      .catch((error: unknown) => {
        migrated = null;
        throw error;
      });
    await migrated;
    return db.q(text, params);
  };
  const sealKey = tenantSettingsKey(keyMaterial);
  const columns = TENANT_SETTING_KEYS.map(tenantSettingColumn).join(", ");
  return {
    tenants: async () => (await q("SELECT id::text AS id FROM tenants")).map((row) => String(row.id)),
    tenantForSlug: async (slug) => {
      const [row] = await q("SELECT id::text AS id FROM tenants WHERE slug = $1", [slug]);
      return row ? String(row.id) : null;
    },
    async read(tenant) {
      const [row] = await q(`SELECT ${columns} FROM tenant_settings WHERE tenant_id = ${TENANT}`);
      const values: TenantSettingValues = {};
      if (!row) return values;
      for (const key of TENANT_SETTING_KEYS) {
        const raw = row[tenantSettingColumn(key)];
        if (raw === null || raw === undefined) continue;
        values[key] = TENANT_SECRET_KEYS.has(key) ? openTenantSecret(sealKey, tenant, key, raw as Buffer) : String(raw);
      }
      return values;
    },
    async write(tenant, changes) {
      const keys = TENANT_SETTING_KEYS.filter((key) => changes[key] !== undefined);
      if (!keys.length) return;
      const params = keys.map((key) => {
        const value = changes[key];
        if (value === null || value === undefined) return null;
        return TENANT_SECRET_KEYS.has(key) ? sealTenantSecret(sealKey, tenant, key, value) : value;
      });
      const names = keys.map(tenantSettingColumn);
      await q(
        `INSERT INTO tenant_settings(tenant_id, ${names.join(", ")}) VALUES (${TENANT}, ${names.map((_, i) => `$${i + 1}`).join(", ")})
         ON CONFLICT (tenant_id) DO UPDATE SET ${names.map((name) => `${name} = EXCLUDED.${name}`).join(", ")}, updated_at = now()`,
        params,
      );
    },
  };
}

function applyChanges(values: TenantSettingValues, changes: TenantSettingChanges): TenantSettingValues {
  const next: TenantSettingValues = { ...values };
  for (const key of TENANT_SETTING_KEYS) {
    const change = changes[key];
    if (change === undefined) continue;
    if (change === null || change === "") delete next[key];
    else next[key] = change;
  }
  return next;
}

export interface TenantSettingsStore {
  get(): Promise<TenantSettings>;
  peek(): TenantSettings;
  refreshAll(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  onlyTenant(): Promise<string | null>;
  tenantForSlug(slug: string): Promise<string | null>;
  update(changes: TenantSettingChanges): Promise<TenantSettings>;
}

export interface TenantSettingsStoreOptions {
  db: PgPool;
  keyMaterial: string | Buffer;
  cacheMs?: number;
  now?: () => number;
  onLoad?: (tenant: string, settings: TenantSettings) => void;
}

export class TenantSettingsNotLoadedError extends Error {
  constructor() {
    super("This tenant's settings have not been loaded yet");
    this.name = "TenantSettingsNotLoadedError";
  }
}

export function createTenantSettingsStore(opts: TenantSettingsStoreOptions): TenantSettingsStore {
  const backing = postgresBacking(opts.db, opts.keyMaterial);
  const cacheMs = opts.cacheMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const loading = new Map<string, { at: number; settings: Promise<TenantSettings> }>();
  const loaded = new Map<string, TenantSettings>();

  function load(tenant: string, fresh = false): Promise<TenantSettings> {
    const hit = loading.get(tenant);
    if (hit && now() - hit.at < cacheMs) return hit.settings;
    const settings = withTenant(tenant, () => backing.read(tenant).then((values) => parseTenantSettings(values)));
    const entry = { at: now(), settings };
    loading.set(tenant, entry);
    const stale = fresh ? undefined : loaded.get(tenant);
    settings.then(
      (value) => {
        if (loading.get(tenant) !== entry) return;
        loaded.set(tenant, value);
        withTenant(tenant, () => opts.onLoad?.(tenant, value));
      },
      (error: unknown) => {
        if (loading.get(tenant) !== entry) return;
        if (!stale) return void loading.delete(tenant);
        loading.set(tenant, { at: entry.at, settings: Promise.resolve(stale) });
        reportFailureAs("tenant settings: refresh", undefined)(error);
      },
    );
    return stale ? Promise.resolve(stale) : settings;
  }

  let stopPreload: (() => void) | undefined;
  const refresher = createSweeper(() => store.refreshAll(), 60_000, { label: "tenant settings refresh" });
  const store: TenantSettingsStore = {
    get: () => load(currentTenant()),
    start() {
      refresher.start();
      stopPreload ??= onFirstBind((tenant) => load(tenant));
    },
    async stop() {
      stopPreload?.();
      stopPreload = undefined;
      await refresher.stop();
    },
    tenantForSlug: (slug) => backing.tenantForSlug(slug),
    async onlyTenant() {
      const tenants = await backing.tenants();
      return tenants.length === 1 ? tenants[0]! : null;
    },
    async refreshAll() {
      for (const tenant of await backing.tenants()) {
        await withTenant(tenant, () => load(tenant)).catch(reportFailureAs("tenant settings: refresh", undefined));
      }
    },
    peek() {
      const tenant = currentTenant();
      const settings = loaded.get(tenant);
      if (settings) return settings;
      void load(tenant).catch(reportFailureAs("tenant settings: load", undefined));
      throw new TenantSettingsNotLoadedError();
    },
    async update(changes) {
      const tenant = currentTenant();
      for (const key of Object.keys(changes)) {
        if (!isTenantSettingKey(key)) throw new Error(`${key} is not a tenant setting`);
      }
      const normalized: TenantSettingChanges = {};
      for (const key of TENANT_SETTING_KEYS) {
        const change = changes[key];
        if (change === undefined) continue;
        normalized[key] = change === null || change.trim() === "" ? null : change.trim();
      }
      parseTenantSettings(applyChanges(await backing.read(tenant), normalized));
      await backing.write(tenant, normalized);
      loading.delete(tenant);
      return load(tenant, true);
    },
  };
  return store;
}
