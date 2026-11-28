CREATE UNIQUE INDEX IF NOT EXISTS tenants_teams_tenant ON tenants ((settings->'teams'->>'tenantId'));

CREATE OR REPLACE FUNCTION qm_tenant_for_teams_tenant(key text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $lookup$ SELECT id FROM tenants WHERE settings->'teams'->>'tenantId' = $1 AND id IN (SELECT qm_serving_tenants()) $lookup$;

CREATE OR REPLACE FUNCTION qm_set_tenant_teams(teams jsonb) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $set_teams$
    UPDATE tenants SET settings = CASE WHEN teams IS NULL THEN settings - 'teams'
      ELSE settings || jsonb_build_object('teams', teams) END
    WHERE id = qm_bound_tenant()
  $set_teams$;
