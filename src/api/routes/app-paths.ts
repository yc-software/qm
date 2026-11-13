import { appGitParts } from "../../../plugins/chassis/src/app-git.ts";
import { firstSegment } from "../inbound-tenant.ts";
import type { KeyedTenant } from "./route.ts";

export const appGitTenant: KeyedTenant = {
  by: "deployment",
  key: (_params, url) => appGitParts(url.pathname)?.id,
};

export const appPathTenant: KeyedTenant = { by: "deployment", key: firstSegment("/d/"), signedTenantFirst: true };
