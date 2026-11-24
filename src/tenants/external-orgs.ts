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

const accountDiffers = `CREATE OR REPLACE FUNCTION qm_external_org_account_differs(tenant uuid)
  RETURNS boolean LANGUAGE sql STABLE
  SET search_path = %1$I, pg_temp AS $f$
  SELECT EXISTS (SELECT 1 FROM tenants t JOIN tenant_external_orgs o ON o.tenant = t.id
    WHERE t.id = $1 AND t.settings ? 'partnerChatAccount' AND t.settings->>'partnerChatAccount' IS DISTINCT FROM o.org_id)
  $f$`;

const accountCheck = `CREATE OR REPLACE FUNCTION qm_external_org_account_check()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  DECLARE bound uuid;
  BEGIN
    IF TG_TABLE_NAME = 'tenants' THEN
      bound := NEW.id;
    ELSE
      bound := NEW.tenant;
    END IF;
    IF qm_external_org_account_differs(bound) THEN
      RAISE EXCEPTION 'tenant %% partnerChatAccount differs from its external organization id', bound USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END $f$`;

const existingAccounts = `DO $account$ DECLARE differing text;
  BEGIN
    SELECT string_agg(tenant::text, ', ') INTO differing FROM tenant_external_orgs WHERE qm_external_org_account_differs(tenant);
    IF differing IS NOT NULL THEN
      RAISE EXCEPTION 'tenants % have a partnerChatAccount that differs from their external organization id; set it to the org id or remove it, then rerun migrations', differing USING ERRCODE = 'check_violation';
    END IF;
  END $account$`;

const accountTrigger = (name: string, table: string, events: string) =>
  `CREATE CONSTRAINT TRIGGER ${name} AFTER ${events} ON ${table}
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qm_external_org_account_check()`;

export const TENANT_EXTERNAL_ORG_ACCOUNT: PgMigrationDefinition = {
  id: "0000-tenancy/workspace-company-id",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `DO $account$ BEGIN EXECUTE format($sql$${accountDiffers}$sql$, current_schema()); END $account$`,
    `DO $account$ BEGIN EXECUTE format($sql$${accountCheck}$sql$, current_schema()); END $account$`,
    `REVOKE ALL ON FUNCTION qm_external_org_account_differs(uuid), qm_external_org_account_check() FROM PUBLIC`,
    `DROP TRIGGER IF EXISTS tenants_external_org_account ON tenants`,
    accountTrigger("tenants_external_org_account", "tenants", "INSERT OR UPDATE OF settings"),
    `DROP TRIGGER IF EXISTS tenant_external_orgs_account ON tenant_external_orgs`,
    accountTrigger("tenant_external_orgs_account", "tenant_external_orgs", "INSERT OR UPDATE"),
    existingAccounts,
  ],
};
