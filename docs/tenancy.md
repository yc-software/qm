# Tenancy in Postgres

Every table that holds a tenant's data has `tenant_id UUID NOT NULL REFERENCES tenants(id)`, a primary key and unique keys that start with `tenant_id`, row level security enabled (not forced), and one policy, `tenant_isolation`, that admits only rows of `qm_bound_tenant()`. New rows default to `qm_bound_tenant()`. `test/tenant-tables.test.ts` lists the few process-level tables that stay untenanted, each with its reason, and fails when any other table lacks this shape.

## Which tenant a query runs as

Core binds a tenant with `withTenant`. The pool then sets `qm.tenant_id` for each query, and `qm_bound_tenant()` returns it.

When no tenant is bound, `qm_bound_tenant()` returns the only row of `tenants` if there is exactly one, and raises `No tenant is bound to this query` otherwise. A single-tenant install therefore behaves as before without binding anything. As soon as a second tenant is inserted, unbound work fails closed on its next statement; no restart is needed. Code that needs the same answer in JavaScript, for example to key a cache, calls `workTenant(pg)` from `src/tenants/work-tenant.ts`.

## Logins

Migrations run as the table owner (`node src/migrate-main.ts` with `DATABASE_URL` set to the owner login). The owner bypasses row level security, so existing single-tenant installs that connect as the owner keep working unchanged.

A multitenant deployment connects core as a separate login that does not own the tables, so every query is filtered by the policies. Create it by hand once per database, as a superuser or the owner:

```sql
CREATE ROLE qm_app LOGIN PASSWORD '<secret>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE <database> TO qm_app;
GRANT USAGE ON SCHEMA public TO qm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qm_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tenants, tenant_hosts FROM qm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO qm_app;
GRANT USAGE ON SCHEMA pgboss TO qm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO qm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO qm_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO qm_app;
```

The cron queue lives in the `pgboss` schema. `migrate-main` creates that schema and the cron queue as the owner, so run it before granting; core under `qm_app` uses the queue without running pg-boss DDL and refuses to start if the queue is missing.

`tenants` and `tenant_hosts` carry row level security too: `qm_app` sees only its bound tenant's row and hosts, and cannot write either table. Operator changes to tenants, hosts and settings go through the owner login. Run migrations as the owner before starting core under `qm_app`. Core under `qm_app` checks that every migration it knows has been applied and refuses to start otherwise; it never runs DDL. Background work that claims rows across tenants reads through the owner login (`DATABASE_OWNER_URL`) and binds each row's tenant before acting on it.

## Operator routes

`PUT` and `DELETE /v1/operator/tenants/:tenant/hosts/:host` and `PATCH /v1/operator/tenants/:tenant/settings` change which tenant a host serves and a tenant's settings, including its sign-in configuration. They accept only requests signed like source auth but with `OPERATOR_SIGNING_SECRET`, which must be at least 32 characters, differ from `CORE_SIGNING_SECRET`, and go only to core and operator tooling, never to a plugin process. A request signed with `CORE_SIGNING_SECRET` gets 401; when `OPERATOR_SIGNING_SECRET` is unset, weak, or equal to `CORE_SIGNING_SECRET`, these routes answer 503. The read routes `GET /v1/operator/hosts/:host` and `GET /v1/operator/tenants/:tenant/hosts` stay on source auth, because plugins resolve their host's tenant through the first.
