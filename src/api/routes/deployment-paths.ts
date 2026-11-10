import { deploymentGitParts } from "../../../plugins/chassis/src/deployment-git.ts";
import { firstSegment } from "../inbound-tenant.ts";
import type { KeyedTenant } from "./route.ts";

export const deploymentGitTenant: KeyedTenant = {
  by: "deployment",
  key: (_params, url) => deploymentGitParts(url.pathname)?.id,
};

export const deploymentAppTenant: KeyedTenant = { by: "deployment", key: firstSegment("/d/"), signedTenantFirst: true };
