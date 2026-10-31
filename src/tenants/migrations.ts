import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const TENANT = "qm_bound_tenant()";

export const TENANT_MIGRATIONS: readonly PgMigrationDefinition[] = [
  {
    id: "sessions/store/0048-tenants",
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
      `CREATE OR REPLACE FUNCTION qm_bound_tenant() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
         AS $qm_bound_tenant$ SELECT COALESCE(NULLIF(current_setting('qm.tenant_id', true), '')::uuid, qm_tenant_unbound()) $qm_bound_tenant$`,
      `ALTER TABLE items ALTER COLUMN tenant_id SET DEFAULT qm_bound_tenant()`,
      `ALTER TABLE items ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE items FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY tenant_isolation ON items
         USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())`,
      `DROP FUNCTION qm_tenant_id()`,
      `DROP TABLE qm_tenant`,
    ],
  },
];

export const TENANT_SETTINGS_MIGRATION: PgMigrationDefinition = {
  id: "tenants/0001-settings",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE tenant_settings(
         tenant_id UUID PRIMARY KEY DEFAULT qm_bound_tenant(),
         model_provider TEXT,
         pi_model TEXT,
         pi_detect_model TEXT,
         pi_title_model TEXT,
         pi_judge_model TEXT,
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
         admin_grants TEXT,
         oidc_issuer TEXT,
         oidc_auth_endpoint TEXT,
         oidc_token_endpoint TEXT,
         oidc_userinfo_endpoint TEXT,
         oidc_jwks_uri TEXT,
         oidc_client_id TEXT,
         oidc_scopes TEXT,
         oidc_prompt TEXT,
         oidc_principal_claim TEXT,
         oidc_allowed_email_domain TEXT,
         oidc_allowed_emails TEXT,
         portal_expected_team_id TEXT,
         oidc_client_secret BYTEA,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    `ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON tenant_settings
       USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())`,
  ],
};
