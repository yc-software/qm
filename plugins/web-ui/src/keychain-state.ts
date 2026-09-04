export interface KeychainGrantState {
  credentialId: string;
  status: string;
  expiresAt?: number;
}

export interface KeychainCredentialState {
  id: string;
  kind?: string;
  expiresAt?: number;
}

export function isExpiredCredential(credential: KeychainCredentialState, at = Date.now()): boolean {
  return (
    credential.kind !== "file" &&
    credential.kind !== "connector" &&
    credential.expiresAt !== undefined &&
    credential.expiresAt < at
  );
}

export function isActiveGrant(
  grant: KeychainGrantState,
  credential: KeychainCredentialState | undefined,
  at = Date.now(),
): boolean {
  return (
    credential !== undefined &&
    !isExpiredCredential(credential, at) &&
    grant.status === "active" &&
    (grant.expiresAt === undefined || grant.expiresAt > at)
  );
}

export function keychainSummary(
  providers: Array<{ connected?: boolean; needsReconnect?: boolean }>,
  credentials: KeychainCredentialState[],
  grants: KeychainGrantState[],
  asks: unknown[],
  at = Date.now(),
): { connected: number; activeGrants: number; attention: number } {
  const credentialsById = new Map(credentials.map((credential) => [credential.id, credential]));
  return {
    connected: providers.filter((provider) => provider.connected && !provider.needsReconnect).length,
    activeGrants: grants.filter((grant) => isActiveGrant(grant, credentialsById.get(grant.credentialId), at)).length,
    attention:
      providers.filter((provider) => provider.needsReconnect).length +
      credentials.filter((credential) => isExpiredCredential(credential, at)).length +
      asks.length,
  };
}

export interface KeychainMutation {
  token: symbol;
  epoch: number;
}

export class KeychainOperations {
  private latestLoad = 0;
  private epoch = 0;
  private mutation: symbol | null = null;
  private dropEpoch: number | null = null;

  reset(): void {
    this.latestLoad++;
    this.epoch++;
    this.mutation = null;
    this.dropEpoch = null;
  }

  beginLoad(): number {
    return ++this.latestLoad;
  }

  isCurrentLoad(load: number): boolean {
    return load === this.latestLoad;
  }

  isCurrentEpoch(epoch: number): boolean {
    return epoch === this.epoch;
  }

  captureEpoch(): number {
    return this.epoch;
  }

  beginMutation(): KeychainMutation | null {
    if (this.mutation) return null;
    const token = Symbol();
    this.mutation = token;
    return { token, epoch: this.epoch };
  }

  finishMutation(operation: KeychainMutation): boolean {
    if (!this.isCurrentEpoch(operation.epoch) || this.mutation !== operation.token) return false;
    this.mutation = null;
    return true;
  }

  beginDrop(): number | null {
    if (this.dropEpoch !== null) return null;
    this.dropEpoch = this.epoch;
    return this.epoch;
  }

  finishDrop(epoch: number): void {
    if (this.isCurrentEpoch(epoch) && this.dropEpoch === epoch) this.dropEpoch = null;
  }

  get dropInFlight(): boolean {
    return this.dropEpoch !== null;
  }

  get mutationInFlight(): boolean {
    return this.mutation !== null;
  }
}
