import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import {
  acquireCodexOAuthAuthLock,
  codexOAuthAccountId,
  parseCodexOAuthAuth,
  readCodexOAuthAuthFile,
  verifyCodexOAuthAuth,
  writeCodexOAuthAuthFile,
  type CodexOAuthAuth,
  type CodexOAuthAuthLock,
} from "./codex-auth.ts";

export interface StoredCodexOAuthAuth {
  accountId: string;
  authEnc: string;
  version: number;
  updatedAt: number;
}

export interface CodexOAuthAuthBackend {
  path: string;
  ready(): Promise<void>;
  acquire(signal?: AbortSignal, timeoutMs?: number): Promise<CodexOAuthAuthLock>;
  close(): Promise<void>;
}

type VerifyAuth = (value: unknown) => Promise<CodexOAuthAuth | null>;

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Codex OAuth auth lock acquisition cancelled"));
  return new Promise((resolveWait, rejectWait) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectWait(new Error("Codex OAuth auth lock acquisition cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveWait();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createDurableCodexOAuthAuthBackend(opts: {
  orgId: string;
  backing: DurableMap<StoredCodexOAuthAuth>;
  advisoryLock: AdvisoryLock;
  keyMaterial: Buffer | string;
  bootstrapBase64?: string;
  verifyAuth?: VerifyAuth;
  now?: () => number;
}): CodexOAuthAuthBackend {
  if (!opts.advisoryLock.tryWithLock) throw new Error("durable Codex OAuth requires non-blocking advisory locks");
  if (!opts.backing.update) throw new Error("durable Codex OAuth requires atomic credential updates");
  const tryWithLock = opts.advisoryLock.tryWithLock.bind(opts.advisoryLock);
  const directory = mkdtempSync(join(existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "qm-codex-oauth-"));
  const path = join(directory, "auth.json");
  const recordId = opts.orgId;
  const lockKey = `codex-oauth:${opts.orgId}`;
  const key = deriveConnectorKey(opts.keyMaterial, "codex-oauth");
  const verifyAuth = opts.verifyAuth ?? verifyCodexOAuthAuth;
  const now = opts.now ?? Date.now;
  const closeAbort = new AbortController();
  let bootstrapBase64 = opts.bootstrapBase64;
  let closed = false;
  let closing = false;
  let active = false;
  let entering = 0;
  const enterWaiters = new Set<() => void>();

  const decodeRecord = (record: StoredCodexOAuthAuth): CodexOAuthAuth => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decryptSecret(record.authEnc, key));
    } catch {
      throw new Error("durable Codex OAuth credential cannot be decrypted");
    }
    const auth = parseCodexOAuthAuth(parsed);
    if (!auth || codexOAuthAccountId(auth) !== record.accountId)
      throw new Error("durable Codex OAuth credential is invalid");
    return auth;
  };

  const loadRecord = async (): Promise<{ record: StoredCodexOAuthAuth; auth: CodexOAuthAuth } | null> => {
    const record = await opts.backing.get(recordId);
    return record ? { record, auth: decodeRecord(record) } : null;
  };

  const bootstrapRecord = async (): Promise<{ record: StoredCodexOAuthAuth; auth: CodexOAuthAuth }> => {
    const existing = await loadRecord();
    if (existing) return existing;
    if (!bootstrapBase64) throw new Error("durable Codex OAuth credential is not initialized");
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(bootstrapBase64, "base64").toString("utf8"));
    } catch {
      throw new Error("Codex OAuth bootstrap credential is invalid");
    }
    const auth = await verifyAuth(value);
    const accountId = auth ? codexOAuthAccountId(auth) : undefined;
    if (!auth || !accountId) throw new Error("Codex OAuth bootstrap credential is invalid");
    const candidate: StoredCodexOAuthAuth = {
      accountId,
      authEnc: encryptSecret(JSON.stringify(auth), key),
      version: 1,
      updatedAt: now(),
    };
    const selected = await opts.backing.putIfAbsent(recordId, candidate);
    return { record: selected, auth: decodeRecord(selected) };
  };

  const persistSource = async (): Promise<void> => {
    const auth = readCodexOAuthAuthFile(path);
    if (!auth) throw new Error("Codex OAuth auth persistence refused");
    const current = await loadRecord();
    const sanitized = parseCodexOAuthAuth(auth);
    if (!current || !sanitized) throw new Error("Codex OAuth auth persistence refused");
    if (JSON.stringify(sanitized) === JSON.stringify(current.auth)) return;
    const verified = await verifyAuth(sanitized);
    const accountId = verified ? codexOAuthAccountId(verified) : undefined;
    if (!verified || !accountId || accountId !== current.record.accountId)
      throw new Error("Codex OAuth auth persistence refused");
    const next: StoredCodexOAuthAuth = {
      accountId,
      authEnc: encryptSecret(JSON.stringify(verified), key),
      version: current.record.version + 1,
      updatedAt: now(),
    };
    const updated = await opts.backing.update!(recordId, (record) => {
      if (record.version !== current.record.version || record.accountId !== accountId)
        throw new Error("Codex OAuth credential changed while locked");
      return next;
    });
    if (!updated) throw new Error("durable Codex OAuth credential disappeared while locked");
  };

  const ready = async (): Promise<void> => {
    if (closed || closing) throw new Error("durable Codex OAuth backend is closed");
    try {
      const existing = await loadRecord();
      if (!existing) {
        await opts.advisoryLock.withLock(
          lockKey,
          async () => {
            await bootstrapRecord();
          },
          { signal: closeAbort.signal, timeoutMs: 120_000 },
        );
      }
    } finally {
      bootstrapBase64 = undefined;
      delete opts.bootstrapBase64;
    }
  };

  const acquireInner = async (signal?: AbortSignal, timeoutMs = 120_000): Promise<CodexOAuthAuthLock> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (closed || closing) throw new Error("durable Codex OAuth backend is closed");
      if (signal?.aborted) throw new Error("Codex OAuth auth lock acquisition cancelled");
      let finish!: () => void;
      const hold = new Promise<void>((resolveHold) => {
        finish = resolveHold;
      });
      let resolveEntered!: (lock: CodexOAuthAuthLock) => void;
      let rejectEntered!: (error: unknown) => void;
      const entered = new Promise<CodexOAuthAuthLock>((resolveLock, rejectLock) => {
        resolveEntered = resolveLock;
        rejectEntered = rejectLock;
      });
      const remaining = Math.max(1, deadline - Date.now());
      const attemptSignal = signal ? AbortSignal.any([signal, closeAbort.signal]) : closeAbort.signal;
      const attempt = tryWithLock(
        lockKey,
        async () => {
          let localLock: CodexOAuthAuthLock | undefined;
          try {
            if (closed || closing) throw new Error("durable Codex OAuth backend is closed");
            if (signal?.aborted) throw new Error("Codex OAuth auth lock acquisition cancelled");
            const { auth } = await bootstrapRecord();
            if (closed || closing) throw new Error("durable Codex OAuth backend is closed");
            if (signal?.aborted) throw new Error("Codex OAuth auth lock acquisition cancelled");
            writeCodexOAuthAuthFile(path, auth);
            localLock = await acquireCodexOAuthAuthLock(path, signal, Math.max(1, Math.min(timeoutMs, remaining)));
            active = true;
            let released = false;
            let releasePromise: Promise<void> | undefined;
            const lock: CodexOAuthAuthLock = {
              path: localLock.path,
              isHeld() {
                return !released && Boolean(localLock?.isHeld());
              },
              async release() {
                if (releasePromise) return releasePromise;
                released = true;
                finish();
                releasePromise = completion.then((outcome) => {
                  if (outcome.error) throw outcome.error;
                });
                return releasePromise;
              },
            };
            resolveEntered(lock);
            await hold;
            await persistSource();
          } catch (error) {
            rejectEntered(error);
            throw error;
          } finally {
            active = false;
            try {
              await localLock?.release();
            } finally {
              rmSync(path, { force: true });
            }
          }
        },
        { signal: attemptSignal, timeoutMs: remaining },
      );
      const completion: Promise<{ result: unknown; error: unknown }> = attempt.then(
        (result) => ({ result, error: undefined as unknown }),
        (error: unknown) => ({ result: undefined, error }),
      );
      const outcome = await Promise.race([
        entered.then((lock) => ({ lock, completed: undefined })),
        completion.then((completed) => ({ lock: undefined, completed })),
      ]);
      if (outcome.lock) return outcome.lock;
      if (outcome.completed?.error) throw outcome.completed.error;
      if (closed || closing) throw new Error("durable Codex OAuth backend is closed");
      await waitForRetry(Math.min(100, Math.max(1, deadline - Date.now())), signal);
    }
    throw new Error("timed out acquiring the Codex OAuth auth lock");
  };

  const acquire = (signal?: AbortSignal, timeoutMs = 120_000): Promise<CodexOAuthAuthLock> => {
    if (closed || closing) return Promise.reject(new Error("durable Codex OAuth backend is closed"));
    entering += 1;
    return acquireInner(signal, timeoutMs).finally(() => {
      entering -= 1;
      if (entering === 0) {
        for (const resolveWait of enterWaiters) resolveWait();
        enterWaiters.clear();
      }
    });
  };

  return {
    path,
    ready,
    acquire,
    async close() {
      if (closed) return;
      closing = true;
      closeAbort.abort();
      if (entering > 0) await new Promise<void>((resolveWait) => enterWaiters.add(resolveWait));
      if (active) {
        closing = false;
        throw new Error("cannot close durable Codex OAuth backend while auth is locked");
      }
      closed = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
