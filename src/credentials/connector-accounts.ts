import { isAccountType, type AccountType } from "../connectors/oauth.ts";
import type { ConnectorTokenStore } from "./keychain.ts";

const BUILTIN_ACCOUNT_TYPES = ["default", "personal", "company"] as const;
export const PERSONAL_FIRST_ACCOUNT_TYPES = ["personal", "default", "company"] as const;

function orderAccountNames(
  names: Iterable<string>,
  preferred: readonly string[] = BUILTIN_ACCOUNT_TYPES,
): AccountType[] {
  const extra = [...new Set(names)].filter((name) => isAccountType(name) && !preferred.includes(name)).sort();
  return [...preferred, ...extra];
}

type AccountSlots = (host: string, preferred?: readonly string[]) => AccountType[];

export function accountSlots(owned: ReadonlyArray<{ host: string; accountType?: string }>): AccountSlots {
  return (host, preferred) =>
    orderAccountNames(
      owned.filter((c) => c.host.toLowerCase() === host.toLowerCase()).map((c) => c.accountType ?? "default"),
      preferred,
    );
}

export async function connectorAccountSlots(
  tokens: Pick<ConnectorTokenStore, "listConnectorsByOwners">,
  principalId: string,
): Promise<AccountSlots> {
  const owned = tokens.listConnectorsByOwners
    ? ((await tokens.listConnectorsByOwners([principalId])).get(principalId) ?? [])
    : [];
  return accountSlots(owned);
}
