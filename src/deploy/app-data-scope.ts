import { boundTenant, unboundTenantAllowed } from "../tenants/context.ts";
import { tenantSettings } from "../tenants/settings.ts";

export interface AppDataScope {
  bucket: string;
  prefix: string;
}

export async function appDataScope(
  sharedBucket: string | undefined,
  basePrefix: string,
): Promise<AppDataScope | undefined> {
  if (!sharedBucket) return undefined;
  if (unboundTenantAllowed()) return { bucket: sharedBucket, prefix: basePrefix };
  const tenant = boundTenant();
  if (!tenant) throw new Error("app data access needs a bound tenant on a multitenant deployment");
  const own = (await tenantSettings()).env?.S3_BUCKET;
  return { bucket: own || sharedBucket, prefix: `${basePrefix}/${tenant}` };
}

export const appDataKey = (scope: AppDataScope, deploymentId: string): string => `${scope.prefix}/${deploymentId}.tar`;

export const litestreamKey = (scope: AppDataScope, deploymentId: string): string =>
  `${scope.prefix}/${deploymentId}/litestream`;
