import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

const definer = `CREATE OR REPLACE FUNCTION qm_self_serve_tenant(issuer text, org text, brand text)
  RETURNS TABLE(tenant uuid, created boolean, provisioned boolean, serving boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  DECLARE found uuid; fresh boolean := false;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('qm-self-serve:' || $1 || chr(10) || $2, 0));
    SELECT o.tenant INTO found FROM tenant_external_orgs o WHERE o.issuer = $1 AND o.org_id = $2;
    IF found IS NULL THEN
      IF NOT EXISTS (SELECT 1 FROM tenants) THEN
        RETURN;
      END IF;
      INSERT INTO tenants(settings) VALUES (jsonb_build_object('brandName', $3, 'serving', false, 'deploymentModelKey', false))
        RETURNING id INTO found;
      INSERT INTO tenant_external_orgs(issuer, org_id, tenant) VALUES ($1, $2, found);
      fresh := true;
    END IF;
    RETURN QUERY SELECT found, fresh, o.provisioned_at IS NOT NULL, t.settings->>'serving' IS DISTINCT FROM 'false'
      FROM tenants t JOIN tenant_external_orgs o ON o.tenant = t.id WHERE t.id = found;
  END $f$`;

const provisionedDefiner = `CREATE OR REPLACE FUNCTION qm_self_serve_provisioned(tenant uuid, key text)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  BEGIN
    UPDATE tenant_external_orgs o SET provisioned_at = now() WHERE o.tenant = $1 AND o.provisioned_at IS NULL;
    IF FOUND THEN
      UPDATE tenants t SET settings = t.settings || jsonb_build_object('modelGatewayKey', $2, 'serving', true)
        WHERE t.id = $1;
    END IF;
  END $f$`;

export const TENANT_EXTERNAL_ORGS: PgMigrationDefinition = {
  id: "0000-tenancy/external-orgs",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE IF NOT EXISTS tenant_external_orgs(
      issuer TEXT NOT NULL,
      org_id TEXT NOT NULL,
      tenant UUID NOT NULL UNIQUE REFERENCES tenants(id),
      provisioned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (issuer, org_id)
    )`,
    `ALTER TABLE tenant_external_orgs ENABLE ROW LEVEL SECURITY`,
    `DO $self_serve$ BEGIN EXECUTE format($sql$${definer}$sql$, current_schema()); END $self_serve$`,
    `DO $self_serve$ BEGIN EXECUTE format($sql$${provisionedDefiner}$sql$, current_schema()); END $self_serve$`,
    `REVOKE ALL ON FUNCTION qm_self_serve_tenant(text, text, text), qm_self_serve_provisioned(uuid, text) FROM PUBLIC`,
  ],
};

const provisionedSettingsDefiner = `CREATE OR REPLACE FUNCTION qm_self_serve_provisioned(tenant uuid, settings jsonb)
  RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  DECLARE violated text;
  BEGIN
    UPDATE tenant_external_orgs o SET provisioned_at = now() WHERE o.tenant = $1 AND o.provisioned_at IS NULL;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    UPDATE tenants t SET settings = t.settings || ($2 - 'partnerChatAccount') || jsonb_build_object('serving', true)
      WHERE t.id = $1;
    BEGIN
      UPDATE tenants t SET settings = t.settings || jsonb_build_object('partnerChatAccount', $2->'partnerChatAccount')
        WHERE t.id = $1 AND $2 ? 'partnerChatAccount';
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;
      IF violated IS DISTINCT FROM 'tenants_partner_chat_account' THEN
        RAISE;
      END IF;
      RETURN $2->>'partnerChatAccount';
    END;
    RETURN NULL;
  END $f$`;

export const TENANT_EXTERNAL_ORG_SETTINGS: PgMigrationDefinition = {
  id: "0000-tenancy/external-orgs-provisioned-settings",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `DROP FUNCTION IF EXISTS qm_self_serve_provisioned(uuid, text)`,
    `DO $self_serve$ BEGIN EXECUTE format($sql$${provisionedSettingsDefiner}$sql$, current_schema()); END $self_serve$`,
    `REVOKE ALL ON FUNCTION qm_self_serve_provisioned(uuid, jsonb) FROM PUBLIC`,
  ],
};
