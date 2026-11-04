import { createHash } from "node:crypto";
import { boundTenant } from "./context.ts";
import { loadedTenantSettings, type TenantEnvName } from "./settings.ts";

export type TenantEnvSubset = Partial<Record<TenantEnvName, string>>;

function tenantEnvSubset(names: readonly TenantEnvName[]): TenantEnvSubset | undefined {
  const env = loadedTenantSettings().env ?? {};
  const picked: TenantEnvSubset = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) picked[name] = value;
  }
  return Object.keys(picked).length ? picked : undefined;
}

export function perTenantInstance<T>(
  names: readonly TenantEnvName[],
  build: (env: TenantEnvSubset) => T,
): () => T | undefined {
  const built = new Map<string, { fingerprint: string; value: T }>();
  return () => {
    const tenant = boundTenant();
    const env = tenant === undefined ? undefined : tenantEnvSubset(names);
    if (tenant === undefined || !env) return undefined;
    const fingerprint = createHash("sha256").update(JSON.stringify(env)).digest("hex");
    const cached = built.get(tenant);
    if (cached?.fingerprint === fingerprint) return cached.value;
    const value = build(env);
    built.set(tenant, { fingerprint, value });
    return value;
  };
}
