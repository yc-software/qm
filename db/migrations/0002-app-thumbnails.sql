CREATE TABLE app_thumbnails (
  tenant_id uuid DEFAULT qm_bound_tenant() NOT NULL REFERENCES tenants(id),
  deployment_id text NOT NULL,
  version integer NOT NULL,
  image bytea NOT NULL,
  captured_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, deployment_id),
  FOREIGN KEY (tenant_id, deployment_id) REFERENCES deployments(tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE app_thumbnails ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app_thumbnails
  USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
