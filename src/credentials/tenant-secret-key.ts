import type { SecretKey } from "../connectors/connector-client-store.ts";
import { perTenant } from "../tenant.ts";

export function tenantSecretKey(derive: () => SecretKey): SecretKey {
  const key = perTenant(derive);
  return {
    get current() {
      return key().current;
    },
    get v1() {
      return key().v1;
    },
    get fallbacks() {
      return key().fallbacks;
    },
  };
}
