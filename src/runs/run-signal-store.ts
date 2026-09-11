import { randomUUID } from "node:crypto";
import type { TurnRequest } from "../types.ts";

export type RunSignalKind = "abort" | "steer";

export interface RunSignal {
  kind: RunSignalKind;
  text?: string;
  ts?: string;
  request?: TurnRequest;
  dedupeKey?: string;
  queuedRunId?: string;
}

export interface SavedRunSignal extends RunSignal {
  id: string;
  runId: string;
  deliveryRunId?: string;
  transferring?: boolean;
}

export type SignalAdmission = { status: "sent" | "duplicate"; signal: SavedRunSignal } | { status: "closed" };
type SignalOwner = { readerToken: string } | { terminal: boolean; skipIds?: string[] };
export interface SignalClaim {
  signal: SavedRunSignal;
  token: string;
}

export interface RunSignalStoreOptions {
  readerLeaseValid?(runId: string, leaseToken: string): Promise<boolean>;
  onReaderClosed?(runId: string): Promise<void>;
  readerFinished?(runId: string): Promise<boolean>;
}

export interface RunSignalStore {
  send(runId: string, signal: RunSignal, options?: { allowClosed?: boolean }): Promise<SignalAdmission>;
  get(id: string): Promise<SavedRunSignal | null>;
  getByDedupeKey(dedupeKey: string): Promise<SavedRunSignal | null>;
  hasDedupeKey(dedupeKey: string): Promise<boolean>;
  pending(runId: string): Promise<SavedRunSignal[]>;
  claim(runId: string, owner: SignalOwner, ttlMs: number): Promise<SignalClaim | null>;
  renew(claim: SignalClaim, ttlMs: number): Promise<boolean>;
  ack(claim: SignalClaim, deliveryRunId?: string): Promise<boolean>;
  release(claim: SignalClaim): Promise<void>;
  aborted(runId: string, readerToken: string): Promise<boolean>;
  steerAuthors(runId: string): Promise<string[]>;
  pendingRunIds(): Promise<string[]>;
  prune(olderThanMs: number): Promise<void>;
  onSignal(runId: string, cb: () => void): () => void;
  openReader(runId: string, token: string, leaseToken?: string): Promise<void>;
  closeReader(runId: string, token: string): Promise<void>;
  readerClosed(runId: string): Promise<boolean>;
  close?(): Promise<void>;
}

export const SIGNAL_CLAIM_MS = 30_000;

export function createMemoryRunSignalStore(opts: RunSignalStoreOptions = {}): RunSignalStore {
  const records = new Map<
    string,
    { signal: SavedRunSignal; consumedAt?: number; claim?: { token: string; readerToken?: string; expiresAt: number } }
  >();
  const listeners = new Map<string, Set<() => void>>();
  const readers = new Map<string, { token: string; closedAt: number | null; leaseToken?: string }>();
  const valid = (claim: SignalClaim, requireUnexpired = true) => {
    const record = records.get(claim.signal.id);
    const lease = record?.claim;
    return record &&
      !record.consumedAt &&
      lease?.token === claim.token &&
      (!requireUnexpired || lease.expiresAt > Date.now()) &&
      (!lease.readerToken ||
        (readers.get(claim.signal.runId)?.token === lease.readerToken &&
          readers.get(claim.signal.runId)?.closedAt === null))
      ? record
      : undefined;
  };
  return {
    async send(runId, signal, options) {
      const duplicate = signal.dedupeKey
        ? [...records.values()].find((record) => record.signal.dedupeKey === signal.dedupeKey)?.signal
        : undefined;
      if (duplicate) return { status: "duplicate", signal: structuredClone(duplicate) };
      if (!options?.allowClosed && signal.kind === "steer" && readers.get(runId)?.closedAt != null)
        return { status: "closed" };
      const saved = {
        ...structuredClone(signal),
        id: randomUUID(),
        runId,
        ...(readers.get(runId)?.closedAt != null ? { transferring: true } : {}),
      };
      records.set(saved.id, { signal: saved });
      for (const cb of listeners.get(runId) ?? []) cb();
      return { status: "sent", signal: structuredClone(saved) };
    },
    async get(id) {
      return structuredClone(records.get(id)?.signal ?? null);
    },
    async getByDedupeKey(key) {
      const record = [...records.values()].find(({ signal }) => signal.dedupeKey === key);
      return record ? structuredClone(record.signal) : null;
    },
    async hasDedupeKey(key) {
      return !!(await this.getByDedupeKey(key));
    },
    async pending(runId) {
      return [...records.values()]
        .filter((record) => record.signal.runId === runId && !record.consumedAt)
        .map((record) => structuredClone(record.signal));
    },
    async claim(runId, owner, ttlMs) {
      const reader = readers.get(runId);
      if (
        "readerToken" in owner &&
        reader?.leaseToken &&
        opts.readerLeaseValid &&
        !(await opts.readerLeaseValid?.(runId, reader.leaseToken))
      )
        return null;
      if (readers.get(runId) !== reader) return null;
      if ("readerToken" in owner) {
        if (reader?.token !== owner.readerToken || reader.closedAt !== null) return null;
      }
      const pending = [...records.values()].filter((record) => record.signal.runId === runId && !record.consumedAt);
      const skipIds = "terminal" in owner ? (owner.skipIds ?? []) : [];
      const record = pending.find(
        (record) =>
          record.signal.kind === "steer" &&
          !skipIds.includes(record.signal.id) &&
          ("terminal" in owner || !record.signal.transferring),
      );
      if ("terminal" in owner && !owner.terminal && reader?.closedAt == null && !record?.signal.transferring)
        return null;
      if (record?.claim && record.claim.expiresAt > Date.now()) return null;
      if ("terminal" in owner && owner.terminal) {
        if (reader) reader.closedAt ??= Date.now();
        for (const abort of pending.filter((record) => record.signal.kind === "abort")) abort.consumedAt = Date.now();
      }
      if (!record) return null;
      if ("terminal" in owner) record.signal.transferring = true;
      const token = randomUUID();
      record.claim = {
        token,
        expiresAt: Date.now() + ttlMs,
        ...("readerToken" in owner ? { readerToken: owner.readerToken } : {}),
      };
      return { signal: structuredClone(record.signal), token };
    },
    async renew(claim, ttlMs) {
      const reader = readers.get(claim.signal.runId);
      if (
        records.get(claim.signal.id)?.claim?.readerToken &&
        reader?.leaseToken &&
        opts.readerLeaseValid &&
        !(await opts.readerLeaseValid?.(claim.signal.runId, reader.leaseToken))
      )
        return false;
      const record = valid(claim);
      if (!record) return false;
      record.claim!.expiresAt = Date.now() + ttlMs;
      return true;
    },
    async ack(claim, deliveryRunId) {
      const record = valid(claim, false);
      if (!record) return false;
      record.consumedAt = Date.now();
      if (deliveryRunId) record.signal.deliveryRunId = deliveryRunId;
      delete record.claim;
      return true;
    },
    async release(claim) {
      const record = records.get(claim.signal.id);
      if (record?.claim?.token === claim.token) delete record.claim;
    },
    async aborted(runId, token) {
      return (
        readers.get(runId)?.token === token &&
        readers.get(runId)?.closedAt === null &&
        [...records.values()].some(
          (record) => record.signal.runId === runId && record.signal.kind === "abort" && !record.consumedAt,
        )
      );
    },
    async openReader(runId, token, leaseToken) {
      if (leaseToken && opts.readerLeaseValid && !(await opts.readerLeaseValid(runId, leaseToken)))
        throw new Error("run execution lease lost");
      if (
        [...records.values()].some(
          (record) =>
            record.signal.runId === runId &&
            record.claim?.readerToken &&
            record.claim.expiresAt > Date.now() &&
            record.claim.readerToken !== token,
        )
      )
        throw new Error("signal reader still accepting");
      readers.set(runId, { token, closedAt: null, ...(leaseToken ? { leaseToken } : {}) });
    },
    async closeReader(runId, token) {
      const reader = readers.get(runId);
      if (reader?.token !== token || reader.closedAt !== null) return;
      reader.closedAt = Date.now();
      await opts.onReaderClosed?.(runId);
    },
    async readerClosed(runId) {
      return readers.get(runId)?.closedAt != null;
    },
    async steerAuthors(runId) {
      return [
        ...new Set(
          [...records.values()]
            .filter((record) => record.signal.runId === runId)
            .flatMap((record) => record.signal.request?.actor.externalId ?? []),
        ),
      ];
    },
    async pendingRunIds() {
      return [
        ...new Set([...records.values()].filter((record) => !record.consumedAt).map((record) => record.signal.runId)),
      ];
    },
    async prune(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      for (const [id, record] of records) if (record.consumedAt && record.consumedAt < cutoff) records.delete(id);
      for (const [runId, reader] of readers) {
        if (
          reader.closedAt !== null &&
          reader.closedAt < cutoff &&
          (await opts.readerFinished?.(runId)) &&
          readers.get(runId) === reader
        )
          readers.delete(runId);
      }
    },
    onSignal(runId, cb) {
      const set = listeners.get(runId) ?? new Set();
      set.add(cb);
      listeners.set(runId, set);
      return () => {
        set.delete(cb);
        if (!set.size) listeners.delete(runId);
      };
    },
  };
}

interface SignalDelivery {
  accepted(): Promise<void>;
  cancel: AbortSignal;
}

export interface SignalPollHandlers {
  onSteer(text: string, ts: string | undefined, signalId: string, delivery: SignalDelivery): Promise<void>;
  onAbort(): Promise<void>;
}

export function startSignalPoll(
  signals: RunSignalStore,
  runId: string,
  handlers: SignalPollHandlers,
  opts?: { intervalMs?: number; onError?: (e: unknown) => void; drainOnStop?: boolean; runLeaseToken?: string },
): () => Promise<void> {
  const readerToken = randomUUID();
  let ready: Promise<void> | undefined;
  const open = (): Promise<void> =>
    (ready ??= signals.openReader(runId, readerToken, opts?.runLeaseToken).catch((error: unknown) => {
      ready = undefined;
      throw error;
    }));
  void open().catch((error: unknown) => opts?.onError?.(error));
  let accepting = true;
  let inFlight: Promise<void> | undefined;
  let dirty = false;
  let aborting: Promise<void> | undefined;
  const checkAbort = (): void => {
    if (aborting) return;
    aborting = (async () => {
      await open();
      if (await signals.aborted(runId, readerToken)) await handlers.onAbort();
    })()
      .catch((error: unknown) => opts?.onError?.(error))
      .finally(() => {
        aborting = undefined;
      });
  };
  const drain = (forced = false): void => {
    if (!accepting && !forced) return;
    checkAbort();
    if (inFlight) {
      dirty = true;
      return;
    }
    dirty = false;
    inFlight = (async () => {
      await open();
      while (accepting || forced) {
        const claim = await signals.claim(runId, { readerToken }, SIGNAL_CLAIM_MS);
        if (!claim) break;
        const controller = new AbortController();
        let accepted = false;
        let acknowledged = false;
        const acknowledge = async (): Promise<void> => {
          accepted = true;
          while (!acknowledged) {
            try {
              acknowledged = await signals.ack(claim);
              if (!acknowledged) {
                controller.abort();
                break;
              }
            } catch (error) {
              opts?.onError?.(error);
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
        };
        let cancellation: Promise<void> | undefined;
        const cancelUnaccepted = (): Promise<void> => {
          if (cancellation) return cancellation;
          if (accepted || acknowledged || controller.signal.aborted) return Promise.resolve();
          cancellation = (async () => {
            accepting = false;
            controller.abort();
            await handlers.onAbort();
          })();
          return cancellation;
        };
        const heartbeat = setInterval(() => {
          if (acknowledged) return;
          void signals
            .renew(claim, SIGNAL_CLAIM_MS)
            .then(async (renewed) => {
              if (!renewed) await cancelUnaccepted();
            })
            .catch((error: unknown) => {
              opts?.onError?.(error);
              void cancelUnaccepted().catch((error: unknown) => opts?.onError?.(error));
            });
        }, SIGNAL_CLAIM_MS / 3);
        heartbeat.unref?.();
        try {
          if (!claim.signal.text?.trim()) throw new Error("steer has no live content");
          await handlers.onSteer(claim.signal.text, claim.signal.ts, claim.signal.id, {
            accepted: acknowledge,
            cancel: controller.signal,
          });
          if (!accepted) await acknowledge();
          if (!acknowledged) break;
        } finally {
          clearInterval(heartbeat);
          await cancellation;
          if (!accepted || acknowledged) await signals.release(claim);
        }
      }
    })()
      .catch((error: unknown) => opts?.onError?.(error))
      .finally(() => {
        inFlight = undefined;
        if (dirty && accepting) drain();
      });
  };
  const unsubscribe = signals.onSignal(runId, drain);
  const timer = setInterval(drain, opts?.intervalMs ?? 5_000);
  timer.unref?.();
  drain();
  let stopping: Promise<void> | undefined;
  return () =>
    (stopping ??= (async () => {
      accepting = false;
      clearInterval(timer);
      unsubscribe();
      await open();
      await inFlight;
      await aborting;
      if (opts?.drainOnStop) {
        drain(true);
        await inFlight;
        await aborting;
      }
      await signals.closeReader(runId, readerToken);
    })());
}
