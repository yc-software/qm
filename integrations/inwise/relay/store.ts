import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { EncryptedEnvelope, RelayRequest } from "../common/protocol.js";

export interface PairingRecord {
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

export interface PairingAdmission {
  sourceKey: string;
  maxPerWindow: number;
  windowMs: number;
  maxPendingPerSource: number;
  maxPendingGlobal: number;
  maxTotalPerSource: number;
  maxTotalGlobal: number;
}

export type RequestState =
  | { status: "pending"; expiresAt: string }
  | { status: "responded"; expiresAt: string; envelope: EncryptedEnvelope }
  | { status: "expired"; expiresAt: string };

export class StoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface RelayStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createPairing(cliPublicKey: string, ttlMs: number, admission: PairingAdmission): Promise<CreatedPairing>;
  claimPairing(code: string, edgePublicKey: string, deviceName: string): Promise<ClaimedPairing>;
  authenticateCli(pairingId: string, token: string): Promise<PairingRecord | undefined>;
  authenticateEdge(deviceId: string, token: string): Promise<PairingRecord | undefined>;
  enqueueRequest(deviceId: string, request: RelayRequest, ttlMs: number): Promise<RequestState>;
  getRequest(pairingId: string, requestId: string): Promise<RequestState | undefined>;
  leaseRequest(deviceId: string, leaseMs: number): Promise<RelayRequest | undefined>;
  respond(deviceId: string, requestId: string, envelope: EncryptedEnvelope): Promise<boolean>;
  cleanup(): Promise<void>;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pairingCode(): string {
  const bytes = randomBytes(8);
  return [...bytes].map((value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join("");
}

export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function matchesDigest(value: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const actual = Buffer.from(digest(value), "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

interface MemoryRequest {
  deviceId: string;
  request: RelayRequest;
  expiresAt: string;
  leaseUntil?: number;
  response?: EncryptedEnvelope;
}

/** Test-only store with the same lifecycle semantics as the Postgres store. */
export class MemoryRelayStore implements RelayStore {
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly requests = new Map<string, MemoryRequest>();
  private readonly rateWindows = new Map<string, { startedAt: number; count: number }>();

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async createPairing(cliPublicKey: string, ttlMs: number, admission: PairingAdmission): Promise<CreatedPairing> {
    await this.cleanup();
    const now = Date.now();
    const window = this.rateWindows.get(admission.sourceKey);
    const current =
      !window || now - window.startedAt >= admission.windowMs
        ? { startedAt: now, count: 1 }
        : { ...window, count: window.count + 1 };
    this.rateWindows.set(admission.sourceKey, current);
    if (current.count > admission.maxPerWindow) {
      throw new StoreError(
        429,
        "Pairing creation rate limit exceeded",
        Math.max(0, admission.windowMs - (now - current.startedAt)),
      );
    }
    const pending = [...this.pairings.values()].filter((item) => !item.deviceId && Date.parse(item.expiresAt) > now);
    const totalForSource = [...this.pairings.values()].filter(
      (item) => (item as PairingRecord & { sourceKey?: string }).sourceKey === admission.sourceKey,
    ).length;
    if (
      pending.length >= admission.maxPendingGlobal ||
      pending.filter((item) => (item as PairingRecord & { sourceKey?: string }).sourceKey === admission.sourceKey)
        .length >= admission.maxPendingPerSource ||
      this.pairings.size >= admission.maxTotalGlobal ||
      totalForSource >= admission.maxTotalPerSource
    ) {
      throw new StoreError(429, "Pairing admission limit reached", admission.windowMs);
    }
    const pairingId = randomUUID();
    const code = pairingCode();
    const cliToken = secret();
    const expiresAt = new Date(now + ttlMs).toISOString();
    this.pairings.set(pairingId, {
      id: pairingId,
      codeHash: digest(code),
      cliTokenHash: digest(cliToken),
      cliPublicKey,
      expiresAt,
      sourceKey: admission.sourceKey,
    } as PairingRecord & { sourceKey: string });
    return { pairingId, code, cliToken, expiresAt };
  }

  async claimPairing(code: string, edgePublicKey: string, deviceName: string): Promise<ClaimedPairing> {
    const record = [...this.pairings.values()].find(
      (candidate) =>
        !candidate.deviceId &&
        Date.parse(candidate.expiresAt) > Date.now() &&
        matchesDigest(code.toUpperCase(), candidate.codeHash),
    );
    if (!record) throw new StoreError(400, "Pairing code is invalid or expired");
    const edgeToken = secret();
    record.deviceId = randomUUID();
    record.deviceName = deviceName;
    record.edgeTokenHash = digest(edgeToken);
    record.edgePublicKey = edgePublicKey;
    return {
      pairingId: record.id,
      deviceId: record.deviceId,
      edgeToken,
      cliPublicKey: record.cliPublicKey,
    };
  }

  async authenticateCli(pairingId: string, token: string): Promise<PairingRecord | undefined> {
    const record = this.pairings.get(pairingId);
    if (
      !record ||
      (!record.deviceId && Date.parse(record.expiresAt) <= Date.now()) ||
      !matchesDigest(token, record.cliTokenHash)
    ) {
      return undefined;
    }
    return record;
  }

  async authenticateEdge(deviceId: string, token: string): Promise<PairingRecord | undefined> {
    const record = [...this.pairings.values()].find((item) => item.deviceId === deviceId);
    return record && matchesDigest(token, record.edgeTokenHash) ? record : undefined;
  }

  async enqueueRequest(deviceId: string, request: RelayRequest, ttlMs: number): Promise<RequestState> {
    const existing = this.requests.get(request.requestId);
    if (existing) {
      if (existing.deviceId !== deviceId || existing.request.pairingId !== request.pairingId) {
        throw new StoreError(409, "Request id is already in use");
      }
      return this.requestState(existing);
    }
    const item: MemoryRequest = {
      deviceId,
      request,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    this.requests.set(request.requestId, item);
    return this.requestState(item);
  }

  async getRequest(pairingId: string, requestId: string): Promise<RequestState | undefined> {
    const item = this.requests.get(requestId);
    return item?.request.pairingId === pairingId ? this.requestState(item) : undefined;
  }

  async leaseRequest(deviceId: string, leaseMs: number): Promise<RelayRequest | undefined> {
    const now = Date.now();
    const item = [...this.requests.values()].find(
      (candidate) =>
        candidate.deviceId === deviceId &&
        !candidate.response &&
        Date.parse(candidate.expiresAt) > now &&
        (!candidate.leaseUntil || candidate.leaseUntil <= now),
    );
    if (!item) return undefined;
    item.leaseUntil = now + leaseMs;
    return item.request;
  }

  async respond(deviceId: string, requestId: string, envelope: EncryptedEnvelope): Promise<boolean> {
    const item = this.requests.get(requestId);
    if (!item || item.deviceId !== deviceId || Date.parse(item.expiresAt) <= Date.now()) {
      return false;
    }
    item.response ??= envelope;
    return true;
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [id, pairing] of this.pairings) {
      if (!pairing.deviceId && Date.parse(pairing.expiresAt) <= now) {
        this.pairings.delete(id);
      }
    }
    for (const [id, request] of this.requests) {
      if (Date.parse(request.expiresAt) + 60_000 <= now) this.requests.delete(id);
    }
  }

  pairingCount(): number {
    return this.pairings.size;
  }

  private requestState(item: MemoryRequest): RequestState {
    if (item.response) {
      return {
        status: "responded",
        expiresAt: item.expiresAt,
        envelope: item.response,
      };
    }
    return Date.parse(item.expiresAt) <= Date.now()
      ? { status: "expired", expiresAt: item.expiresAt }
      : { status: "pending", expiresAt: item.expiresAt };
  }
}
