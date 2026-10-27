import { parseArgs } from "node:util";
import { configurePgCaTrust, configurePgTenancy } from "./persistence/pg-pool.ts";
import { importTenant, migrateWithBuild } from "./tenants/import.ts";
import { TENANT_SECRET_NAMES, TENANT_TEXT_SETTINGS } from "../plugins/chassis/src/tenant-settings.ts";
import { tenantSecretsKey, upsertTenant, type TenantSettings } from "./tenants/registry.ts";

const USAGE = `usage: node src/tenant-import-main.ts [source] [staging] [target] [tenant] [options]
  source:   --source-url <url> | --admin-url-env <NAME> --source-db <name>
  staging:  --staging-url <url> | --admin-url-env <NAME> --staging-db <name>
  target:   --target-url <url> | --target-url-env <NAME> (default DATABASE_URL)
  tenant:   --spec-env <NAME> (JSON {slug, orgId, hosts, ...settings, secrets})
            | --slug <slug> --org-id <id> [--hosts a,b]
  options:  [--tenant-id <uuid>] [--create-staging] [--batch-size <n>]
            [--replace] [--allow-extra-columns] [--dry-run]`;

type TenantSpec = Omit<TenantSettings, "id" | "status">;

const TEXT_SETTINGS = TENANT_TEXT_SETTINGS.map(([field]) => field);

function strings<K extends string>(source: Record<string, unknown>, names: readonly K[], label: string) {
  const known = new Set<string>(names);
  const unknown = Object.keys(source).filter((name) => !known.has(name));
  if (unknown.length) throw new Error(`${label}: unknown field(s) ${unknown.join(", ")}`);
  const out: Partial<Record<K, string>> = {};
  for (const name of names) {
    const value = source[name];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") throw new Error(`${label}.${name} must be a string`);
    out[name] = value;
  }
  return out;
}

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function specFromEnv(name: string): TenantSpec {
  const raw = process.env[name];
  if (!raw) throw new Error(`--spec-env: ${name} is not set`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} does not hold valid JSON`);
  }
  const { slug, orgId, hosts = [], oidcAdmin = false, secrets, ...settings } = objectOf(parsed, name);
  if (typeof slug !== "string" || !slug) throw new Error(`${name}: slug must be a non-empty string`);
  if (typeof orgId !== "string" || !orgId) throw new Error(`${name}: orgId must be a non-empty string`);
  if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== "string")) {
    throw new Error(`${name}: hosts must be an array of strings`);
  }
  if (typeof oidcAdmin !== "boolean") throw new Error(`${name}: oidcAdmin must be a boolean`);
  return {
    slug,
    orgId,
    hosts: hosts as string[],
    ...strings(settings, TEXT_SETTINGS, name),
    oidcAdmin,
    secrets: strings(objectOf(secrets, `${name}.secrets`), TENANT_SECRET_NAMES, `${name}.secrets`),
  };
}

function urlFromEnv(name: string, flag: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${flag}: ${name} is not set`);
  parseUrl(value, name);
  return value;
}

function parseUrl(url: string, label: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`${label} is not a valid connection URL`);
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = parseUrl(url, "the admin database URL");
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

function describeSpec(spec: TenantSpec): string {
  const settings = TEXT_SETTINGS.filter((name) => spec[name] !== undefined);
  return `settings: ${[...settings, ...(spec.oidcAdmin ? ["oidcAdmin"] : [])].join(", ") || "none"}; secrets: ${Object.keys(spec.secrets).join(", ") || "none"}`;
}

const { values } = parseArgs({
  options: {
    "source-url": { type: "string" },
    "admin-url-env": { type: "string" },
    "source-db": { type: "string" },
    "staging-db": { type: "string" },
    "target-url-env": { type: "string" },
    "spec-env": { type: "string" },
    "staging-url": { type: "string" },
    "target-url": { type: "string" },
    slug: { type: "string" },
    "org-id": { type: "string" },
    hosts: { type: "string" },
    "tenant-id": { type: "string" },
    "create-staging": { type: "boolean", default: false },
    "batch-size": { type: "string", default: "500" },
    replace: { type: "boolean", default: false },
    "allow-extra-columns": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

function usageError(message: string): never {
  console.error(`[qm:tenant-import] ${message}\n${USAGE}`);
  process.exit(2);
}

async function main(): Promise<void> {
  configurePgCaTrust({ cert: process.env.DATABASE_CA_CERT, certFile: process.env.DATABASE_CA_CERT_FILE });
  const adminUrlEnv = values["admin-url-env"];
  const adminUrl = adminUrlEnv ? urlFromEnv(adminUrlEnv, "--admin-url-env") : undefined;
  const sourceUrl =
    values["source-url"] || (adminUrl && values["source-db"] ? withDatabase(adminUrl, values["source-db"]) : undefined);
  const stagingUrl =
    values["staging-url"] ||
    (adminUrl && values["staging-db"] ? withDatabase(adminUrl, values["staging-db"]) : undefined);
  const targetUrl = values["target-url"] || urlFromEnv(values["target-url-env"] ?? "DATABASE_URL", "--target-url-env");
  if (!sourceUrl) usageError("no source database");
  if (!stagingUrl) usageError("no staging database");
  const spec: TenantSpec = values["spec-env"]
    ? specFromEnv(values["spec-env"])
    : {
        slug: values.slug ?? usageError("--slug or --spec-env is required"),
        orgId: values["org-id"] ?? usageError("--org-id or --spec-env is required"),
        hosts: (values.hosts ?? "")
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
        oidcAdmin: false,
        secrets: {},
      };
  if (new Set([sourceUrl, stagingUrl, targetUrl]).size !== 3) {
    usageError("the source, staging and target databases must be three different databases");
  }
  const batchSize = Number(values["batch-size"]);
  if (!Number.isInteger(batchSize) || batchSize < 1) usageError("--batch-size must be a positive integer");

  configurePgTenancy(true, tenantSecretsKey(process.env));
  const log = (line: string) => console.log(`[qm:tenant-import] ${line}`);
  log(`tenant ${spec.slug} (org ${spec.orgId}); hosts: ${spec.hosts.join(", ") || "none"}`);
  log(describeSpec(spec));

  const result = await importTenant({
    sourceUrl,
    stagingUrl,
    targetUrl,
    slug: spec.slug,
    orgId: spec.orgId,
    hosts: spec.hosts,
    ...(values["tenant-id"] ? { tenantId: values["tenant-id"] } : {}),
    dryRun: values["dry-run"],
    replace: values.replace,
    allowExtraColumns: values["allow-extra-columns"],
    createStaging: values["create-staging"],
    ...(adminUrl ? { maintenanceUrl: adminUrl } : {}),
    batchSize,
    migrate: migrateWithBuild(process.env, { tenantize: true, orgId: spec.orgId }),
    writeTenant: (id, db) => upsertTenant(db, { id, ...spec, status: "active" }, tenantSecretsKey(process.env)),
    log,
  });
  log(
    result.committed
      ? `imported ${result.tables.length} tables`
      : "dry run complete; nothing was written to the target",
  );
}

await main();
