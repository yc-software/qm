# Native multitenancy

QM can run several companies inside one core process. A single HTTP listener routes each request to a tenant runtime. One process-wide limit controls active turns across those runtimes, and each company retains its own smaller limit. Idle companies no longer require their own core ECS tasks.

```mermaid
flowchart LR
  A[Company A ingress] --> H[Shared core host]
  B[Company B ingress] --> H
  H --> Q[Shared turn capacity]
  Q --> TA[Company A runtime]
  Q --> TB[Company B runtime]
  TA --> DA[(Company A Postgres)]
  TB --> DB[(Company B Postgres)]
  TA --> SA[Company A sandboxes]
  TB --> SB[Company B sandboxes]
```

The tenant boundary is a company. Personal and shared-room scopes continue to work within it. Dedicated deployments use the same runtime with one tenant and retain their existing environment-based configuration and resource names.

## Configure a host

Mount a manifest and one secret-bearing environment file per company. Keep the environment files outside Git and readable only by the host. Paths in `envFile` are relative to the manifest.

```json
{
  "tenants": [
    { "id": "alpha", "hosts": ["alpha.core.example.com"], "envFile": "alpha.env" },
    { "id": "beta", "hosts": ["beta.core.example.com"], "envFile": "beta.env" }
  ]
}
```

An environment file contains the company's existing QM configuration, including:

```dotenv
DATABASE_URL=postgres://alpha:password@postgres.internal:5432/alpha
CORE_SIGNING_SECRET=replace-with-a-unique-random-secret-at-least-32-characters
CAPABILITY_SECRET=replace-with-another-unique-random-secret-at-least-32-characters
PORTAL_IDENTITY_SECRET=replace-with-a-third-unique-random-secret-at-least-32-characters
CONNECTOR_SECRET_KEY=replace-with-a-fourth-unique-random-secret-at-least-32-characters
HARNESS=pi
ANTHROPIC_API_KEY=your-company-model-key
AUTH_ALLOWED_EMAIL_DOMAIN=example.com
ADMIN_GRANTS=admin@example.com:org_admin
SANDBOX_BACKEND=local
WORKERS=2
```

Generate independent values for all four signing/encryption keys. Existing tenants must retain their existing encryption key when moving encrypted credentials. Supply each company's model, connector, Slack, and sandbox configuration explicitly in its environment file. The shared process's credentials are not implicitly inherited by tenant configurations.

Start the core:

```bash
QM_TENANTS_FILE=/run/qm/tenants.json QM_WORKER_CONCURRENCY=16 PORT=8080 npm start
```

`QM_WORKER_CONCURRENCY` caps active turns across the process. A tenant's `WORKERS` caps its own active turns. Capacity is acquired before claiming durable work, and failed claims release it. PostgreSQL claim operations have a short statement timeout so a locked tenant database cannot hold a shared slot indefinitely. Waiting turns remain in that tenant's durable queue.

Pooled mode requires Postgres for sessions and runs. Every company uses a separate database; those databases may live on the same Postgres cluster. Use separate database roles and database-level grants as an additional boundary. Optional `DATABASE_POOL_URL` must address the same company's database. Both direct and pooled endpoints are checked for collisions with other tenants. Query and session pools default to 4 and 8 connections per tenant respectively; tune these against the database server's connection budget.

Tenant IDs are stable lowercase slugs. They become the organization identity and part of default filesystem, object storage, and provider resource namespaces. Startup rejects conflicting IDs, hosts, database targets, signing keys, and overlapping resource namespaces. It cannot identify two different DNS aliases that secretly point to the same database or two provider credentials that refer to the same undeclared resources; operators must provision these correctly.

Pooled provider name prefixes accept only lowercase letters, digits, and hyphens, and must begin and end with a letter or digit. Paths, URL escapes, query strings, fragments, and uppercase characters are rejected before any tenant starts. `FLY_DEPLOY_APP_PREFIX` is limited to 26 characters; longer tenant IDs receive a stable shortened Fly default.

## Ingress and authentication

The core routes by a configured Host header, `x-qm-tenant`, or a tenant claim in a capability token. Conflicting selectors fail before dispatch. A selector is only a routing hint: the selected runtime still verifies its source signature, portal identity, or capability. Pooled mode requires tenant-bound signatures and tokens.

Existing portal and web services use `CORE_TENANT_ID=<manifest-id>` alongside that tenant's `CORE_SIGNING_SECRET` and `PORTAL_IDENTITY_SECRET`. They can connect to the same `CORE_API_URL`. Keep their public domains and login configuration scoped to the company. These front-door services remain separate processes in this change.

Slack Socket Mode runs within each tenant runtime. Each Slack app must belong to only one tenant. For HTTP events, configure the company's tenant hostname as the Slack Request URL: `/slack/events` for its primary account or `/slack/accounts/<account-id>/events` for another account. These endpoints share the core listener in pooled mode and still verify the Slack signing secret. Outbound Slack delivery and installation records live in the company's database. Pooled receivers verify the authenticated Slack app and installed workspace before processing or storing an event. Static duplicate tokens are rejected at startup; connection ownership also rejects active collisions after stored installation updates. Operators must still assign each installation to the correct company and prevent duplicate stored installations across hosts: active connection checks are local to one process.

The egress authorization service also accepts `QM_TENANTS_FILE`. It selects the tenant from the proxy capability, verifies the signature and tenant binding, applies that company's policy, and writes its audit records to that company's database. Tokenless requests are denied in pooled mode.

AWS-backed storage and sandbox providers use the host's IAM identity. Tenant environment files cannot replace that identity with ambient AWS credentials. Give the host access only to its assigned companies' resources, or use separate hosts where distinct IAM boundaries are required.

Sentry initialization belongs to the host process. Configure its destination and deployment identity in the host environment; tenant environment files do not select telemetry destinations. Sanitized backend reports and performance timings share the operator's host telemetry configuration, while tenant error and audit records retain their own database stores.

## Move an existing company

1. Preserve the company's organization ID, database, signing/encryption secrets, model configuration, and resource namespaces in its environment file. Inspect generated defaults before moving existing sandboxes or object storage; changing a prefix changes which resources QM finds.
2. Configure its portal/web services with `CORE_TENANT_ID` and the pooled core URL. Mount its manifest and secrets on the new host.
3. Drain the old company's core before activating its replacement, or use the existing background-ownership deployment protocol. A Slack app must not have two competing Socket Mode consumers.
4. Verify sign-in, a real model/tool turn, existing history, Slack delivery, and published-app access. Retain the previous deployment configuration for rollback.

The manifest and credentials are deployment inputs, so a process restart is required to change tenant membership. Existing per-tenant database migrations run before the shared listener opens. No fleet infrastructure or production data is automatically changed by enabling this code path.

## Capacity and limits

This pools core compute; it does not eliminate per-tenant database connections, resident caches, sandbox compute, portal/web processes, or external service costs. Tenants are currently resident for the host's lifetime. Size a host using measured resident memory, database connections, queue delay, and concurrent turn workload, then assign a bounded set of tenants to each host.

A tenant runtime is a data and configuration boundary inside a trusted Node process, not a process-security boundary. A fatal process error affects every tenant assigned to that host. Use separate hosts for tenants that require separate IAM identities, stronger fault isolation, or different trusted extensions.

The worker-only entrypoint uses the same pooled host and durable run queues. It does not yet define a versioned contract for deploying runners independently of the app. A separate runner service should own complete active turns, including leases, cancellation, and recovery; persist outputs for delivery after app restarts; and resolve tenant configuration from its own trusted registry. Overlapping app and runner versions also require compatible request/event formats and database migrations.

This change does not add automatic tenant placement, idle-runtime eviction, a dynamic control plane, billing, or a new durable workflow engine. Existing run and delivery stores remain the durable execution machinery. Those are separate follow-up decisions for a much larger hosted service.
