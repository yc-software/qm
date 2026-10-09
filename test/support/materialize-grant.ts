import type { Keychain, MaterializedCred } from "../../src/credentials/keychain.ts";

export async function materializeGrant(
  keychain: Pick<Keychain, "prepareMaterialize">,
  grantId: string,
  scopeId: Parameters<Keychain["prepareMaterialize"]>[1],
  usedBy: string,
): Promise<MaterializedCred> {
  const prepared = await keychain.prepareMaterialize(grantId, scopeId, usedBy);
  await prepared.commit();
  return prepared.materialized;
}
