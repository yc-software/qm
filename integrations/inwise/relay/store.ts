import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

interface PairingRecord {
  id: string;
  codeHash: string;
  cliTokenHash: string;
  cliPublicKey: string;
  expiresAt: string;
  deviceId?: string;
  deviceName?: string;
  edgeTokenHash?: string;
  edgePublicKey?: string;
}

interface PersistedState {
  version: 1;
  pairings: PairingRecord[];
}

export interface CreatedPairing {
  pairingId: string;
  code: string;
  cliToken: string;
  expiresAt: string;
}

export interface ClaimedPairing {
  pairingId: string;
  deviceId: string;
  edgeToken: string;
  cliPublicKey: string;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function pairingCode(): string {
  const bytes = randomBytes(8);
  return [...bytes]
    .map((value) => CODE_ALPHABET[value % CODE_ALPHABET.length])
    .join("");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function matchesDigest(value: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const actual = Buffer.from(digest(value), "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export class PairingStore {
  private readonly pairings = new Map<string, PairingRecord>();

  constructor(private readonly stateFile?: string) {
    if (stateFile && existsSync(stateFile)) {
      const state = JSON.parse(
        readFileSync(stateFile, "utf8"),
      ) as PersistedState;
      for (const pairing of state.pairings)
        this.pairings.set(pairing.id, pairing);
    }
  }

  create(cliPublicKey: string, ttlMs = 10 * 60_000): CreatedPairing {
    const pairingId = randomUUID();
    const code = pairingCode();
    const cliToken = secret();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.pairings.set(pairingId, {
      id: pairingId,
      codeHash: digest(code),
      cliTokenHash: digest(cliToken),
      cliPublicKey,
      expiresAt,
    });
    this.persist();
    return { pairingId, code, cliToken, expiresAt };
  }

  claim(
    code: string,
    edgePublicKey: string,
    deviceName: string,
  ): ClaimedPairing {
    const record = [...this.pairings.values()].find(
      (candidate) =>
        !candidate.deviceId &&
        Date.parse(candidate.expiresAt) > Date.now() &&
        matchesDigest(code.toUpperCase(), candidate.codeHash),
    );
    if (!record) throw new Error("Pairing code is invalid or expired");
    const edgeToken = secret();
    record.deviceId = randomUUID();
    record.deviceName = deviceName;
    record.edgeTokenHash = digest(edgeToken);
    record.edgePublicKey = edgePublicKey;
    this.persist();
    return {
      pairingId: record.id,
      deviceId: record.deviceId,
      edgeToken,
      cliPublicKey: record.cliPublicKey,
    };
  }

  authenticateCli(pairingId: string, token: string): PairingRecord | undefined {
    const record = this.pairings.get(pairingId);
    return record && matchesDigest(token, record.cliTokenHash)
      ? record
      : undefined;
  }

  authenticateEdge(deviceId: string, token: string): PairingRecord | undefined {
    const record = [...this.pairings.values()].find(
      (item) => item.deviceId === deviceId,
    );
    return record && matchesDigest(token, record.edgeTokenHash)
      ? record
      : undefined;
  }

  private persist(): void {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    const state: PersistedState = {
      version: 1,
      pairings: [...this.pairings.values()],
    };
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, this.stateFile);
  }
}
