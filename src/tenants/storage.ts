import { join } from "node:path";
import { currentTenant } from "./context.ts";

export function tenantObjectKey(area: string, rel: string): string {
  return `${area}/${currentTenant()}/${rel}`;
}

export function tenantDir(root: string): string {
  return join(root, currentTenant());
}
