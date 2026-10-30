import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const TENANT = "qm_tenant_id()";

export const TENANT_MIGRATIONS: readonly PgMigrationDefinition[] = [
  {
    id: "sessions/store/0047-tenants",
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      `CREATE TABLE tenants(
         id UUID PRIMARY KEY,
         slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
         name TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `INSERT INTO tenants(id, slug, name) SELECT id, 'main', 'Main' FROM qm_tenant`,
      `CREATE OR REPLACE FUNCTION qm_tenant_unbound() RETURNS uuid LANGUAGE plpgsql STABLE PARALLEL SAFE
         AS $qm_tenant_unbound$ BEGIN
           RAISE 'No tenant is bound to this transaction' USING ERRCODE = 'insufficient_privilege';
         END $qm_tenant_unbound$`,
      `CREATE OR REPLACE FUNCTION qm_tenant_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
         AS $qm_tenant_id$ SELECT COALESCE(NULLIF(current_setting('qm.tenant_id', true), '')::uuid, qm_tenant_unbound()) $qm_tenant_id$`,
      `ALTER TABLE items ALTER COLUMN tenant_id SET DEFAULT qm_tenant_id()`,
      `ALTER TABLE items ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE items FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY tenant_isolation ON items
         USING (tenant_id = qm_tenant_id()) WITH CHECK (tenant_id = qm_tenant_id())`,
      `DROP TABLE qm_tenant`,
    ],
  },
  {
    id: "sessions/store/0048-tenant-settings",
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      `CREATE TABLE tenant_settings(
         tenant_id UUID PRIMARY KEY DEFAULT qm_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
         model_provider TEXT,
         pi_model TEXT,
         pi_detect_model TEXT,
         pi_title_model TEXT,
         pi_judge_model TEXT,
         claude_model TEXT,
         anthropic_base_url TEXT,
         openai_base_url TEXT,
         openrouter_base_url TEXT,
         model_gateway_url TEXT,
         model_gateway_api_key BYTEA,
         model_gateway_api_key_header TEXT,
         model_gateway_models TEXT,
         codex_auth_credential TEXT,
         claude_auth_credential TEXT,
         sandbox_backend TEXT,
         sprites_token BYTEA,
         e2b_api_key BYTEA,
         modal_token_id BYTEA,
         modal_token_secret BYTEA,
         do_agents_api_token BYTEA,
         smolmachines_token BYTEA,
         agent37_api_key BYTEA,
         superserve_api_key BYTEA,
         render_sandbox_api_key BYTEA,
         render_sandbox_workspace_id TEXT,
         security_screen TEXT,
         security_screen_classifier TEXT,
         security_screen_proxy_provider TEXT,
         security_screen_proxy_endpoint TEXT,
         security_screen_proxy_token BYTEA,
         auth_allowed_emails TEXT,
         auth_allowed_email_domain TEXT,
         trusted_oidc_admin_issuer TEXT,
         suggested_activities_context TEXT,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY tenant_isolation ON tenant_settings
         USING (tenant_id = qm_tenant_id()) WITH CHECK (tenant_id = qm_tenant_id())`,
    ],
  },
];
