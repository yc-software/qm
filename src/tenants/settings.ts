import { createPgPool, type PgPool } from "../persistence/pg-pool.ts";
import { subscribePostgresChannel } from "../persistence/postgres-listener.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import { currentTenant, withTenant } from "./context.ts";
import { reportFailure } from "../util/errors.ts";
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

export const PLUGIN_SETTING_KEYS: readonly TenantSettingKey[] = TENANT_SETTING_KEYS.filter(
  (key) => key.startsWith("OIDC_") || key === "PORTAL_EXPECTED_TEAM_ID",
);

export type TenantSettingKey = (typeof TENANT_SETTING_KEYS)[number];

const CHANNEL = "qm_tenant_settings";
export type TenantSettingValues = Partial<Record<TenantSettingKey, string>>;
type TenantSettingChanges = Partial<Record<TenantSettingKey, string | null>>;

const TENANT_SECRET_KEYS: ReadonlySet<TenantSettingKey> = new Set<TenantSettingKey>([
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

function tenantSettingColumn(key: TenantSettingKey): string {
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

function associatedData(tenant: string, key: TenantSettingKey): string {
  return `tenant_settings:${tenant}:${key}`;
}

interface TenantSettingsBacking {
  tenants(): Promise<string[]>;
  tenantForSlug(slug: string): Promise<string | null>;
  read(tenant: string): Promise<TenantSettingValues>;
  write(tenant: string, changes: TenantSettingChanges): Promise<void>;
}

function postgresBacking(db: PgPool, keyMaterial: string | Buffer): TenantSettingsBacking {
  const sealKey = deriveConnectorKey(keyMaterial, "tenant-settings");
  const columns = TENANT_SETTING_KEYS.map(tenantSettingColumn).join(", ");
  return {
    tenants: async () => (await db.q("SELECT id::text AS id FROM tenants")).map((row) => String(row.id)),
    tenantForSlug: async (slug) => {
      const [row] = await db.q("SELECT id::text AS id FROM tenants WHERE slug = $1", [slug]);
      return row ? String(row.id) : null;
    },
    async read(tenant) {
      const [row] = await db.q(`SELECT ${columns} FROM tenant_settings WHERE tenant_id = ${TENANT}`);
      const values: TenantSettingValues = {};
      if (!row) return values;
      for (const key of TENANT_SETTING_KEYS) {
        const raw = row[tenantSettingColumn(key)];
        if (raw === null || raw === undefined) continue;
        values[key] = TENANT_SECRET_KEYS.has(key)
          ? decryptSecret(String(raw), sealKey, associatedData(tenant, key))
          : String(raw);
      }
      return values;
    },
    async write(tenant, changes) {
      const keys = TENANT_SETTING_KEYS.filter((key) => changes[key] !== undefined);
      if (!keys.length) return;
      const params = keys.map((key) => {
        const value = changes[key];
        if (value === null || value === undefined) return null;
        return TENANT_SECRET_KEYS.has(key) ? encryptSecret(value, sealKey, associatedData(tenant, key)) : value;
      });
      const names = keys.map(tenantSettingColumn);
      await db.q(
        `WITH saved AS (
           INSERT INTO tenant_settings(tenant_id, ${names.join(", ")}) VALUES (${TENANT}, ${names.map((_, i) => `$${i + 1}`).join(", ")})
           ON CONFLICT (tenant_id) DO UPDATE SET ${names.map((name) => `${name} = EXCLUDED.${name}`).join(", ")}, updated_at = now()
           RETURNING tenant_id
         ) SELECT pg_notify('${CHANNEL}', tenant_id::text) FROM saved`,
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
  databaseUrl: string;
  keyMaterial: string | Buffer;
  onLoad?: (tenant: string, settings: TenantSettings) => void;
}

export class TenantSettingsNotLoadedError extends Error {
  constructor() {
    super("This tenant's settings have not been loaded yet");
    this.name = "TenantSettingsNotLoadedError";
  }
}

export function createTenantSettingsStore(opts: TenantSettingsStoreOptions): TenantSettingsStore {
  const db = createPgPool(opts.databaseUrl);
  db.registerMigration(TENANCY_BASE);
  db.registerMigration(TENANT_SETTINGS_MIGRATION);
  const backing = postgresBacking(db, opts.keyMaterial);
  const latest = new Map<string, Promise<TenantSettings>>();
  const loaded = new Map<string, TenantSettings>();
  let stopListening: (() => Promise<void>) | undefined;

  function read(tenant: string): Promise<TenantSettings> {
    const pending = withTenant(tenant, () => backing.read(tenant).then((values) => parseTenantSettings(values)));
    latest.set(tenant, pending);
    pending.then(
      (value) => {
        if (latest.get(tenant) !== pending) return;
        loaded.set(tenant, value);
        withTenant(tenant, () => opts.onLoad?.(tenant, value));
      },
      (error: unknown) => {
        if (latest.get(tenant) === pending && !loaded.has(tenant)) latest.delete(tenant);
        reportFailure(`tenant settings: load ${tenant}`, error);
      },
    );
    return pending;
  }

  function reload(tenant: string): void {
    if (latest.has(tenant)) void read(tenant);
  }

  const store: TenantSettingsStore = {
    async get() {
      const tenant = currentTenant();
      return loaded.get(tenant) ?? latest.get(tenant) ?? read(tenant);
    },
    peek() {
      const tenant = currentTenant();
      const settings = loaded.get(tenant);
      if (settings) return settings;
      if (!latest.has(tenant)) void read(tenant);
      throw new TenantSettingsNotLoadedError();
    },
    start() {
      stopListening ??= subscribePostgresChannel(opts.databaseUrl, CHANNEL, reload, () => {
        for (const tenant of latest.keys()) reload(tenant);
      });
    },
    async stop() {
      const stopping = stopListening;
      stopListening = undefined;
      await stopping?.();
    },
    tenantForSlug: (slug) => backing.tenantForSlug(slug),
    async onlyTenant() {
      const tenants = await backing.tenants();
      return tenants.length === 1 ? tenants[0]! : null;
    },
    async refreshAll() {
      await Promise.allSettled((await backing.tenants()).map((tenant) => read(tenant)));
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
      return read(tenant);
    },
  };
  return store;
}
