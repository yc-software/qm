import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createMemoryHttpService } from "../src/memory/http-service.ts";
import {
  MemoryOperationConflictError,
  type IdempotentMemoryService,
  type MemoryCaptureOnceInput,
  type MemoryCaptureReceipt,
  type MemoryPurgeReceipt,
} from "../src/memory/memory-service.ts";
import { memoryScopeToken } from "../src/memory/privacy-tokens.ts";

const SECRET = "m".repeat(32);
const SCOPE_TOKEN_SECRET = "t".repeat(32);

function fakeMemory(): IdempotentMemoryService & { captures: MemoryCaptureOnceInput[] } {
  const bodies = new Map<string, string>();
  const operations = new Map<string, { hash: string; receipt: MemoryCaptureReceipt }>();
  const erasures = new Map<string, { hash: string; receipt: MemoryPurgeReceipt }>();
  const captures: MemoryCaptureOnceInput[] = [];
  return {
    captures,
    async recall(scopeId) {
      return bodies.get(scopeId) ?? "";
    },
    async capture(scopeId, facts) {
      bodies.set(scopeId, facts.join("\n"));
      return facts.length;
    },
    async captureOnce(input) {
      const key = `${input.integrationId}:${input.operationId}`;
      const hash = JSON.stringify(input);
      const prior = operations.get(key);
      if (prior) {
        if (prior.hash !== hash) throw new MemoryOperationConflictError();
        return prior.receipt;
      }
      captures.push(input);
      const receipt = { added: input.facts.length, revision: String(captures.length), updatedAt: input.at };
      operations.set(key, { hash, receipt });
      bodies.set(input.scopeId, input.facts.join("\n"));
      return receipt;
    },
    async purgeOnce(input) {
      const key = `${input.integrationId}:${input.operationId}`;
      const hash = JSON.stringify(input);
      const prior = erasures.get(key);
      if (prior) {
        if (prior.hash !== hash) throw new MemoryOperationConflictError();
        return prior.receipt;
      }
      const receipt = {
        erasedRevisions: bodies.has(input.scopeId) ? 1 : 0,
        tombstonedOperations: [...operations.keys()].filter((operation) =>
          operation.startsWith(`${input.integrationId}:`),
        ).length,
        completedAt: input.at,
        scopeHash: "a".repeat(64),
      };
      bodies.delete(input.scopeId);
      erasures.set(key, { hash, receipt });
      return receipt;
    },
    async query(scopeId, query, limit = 20) {
      return (bodies.get(scopeId) ?? "")
        .split("\n")
        .filter((line) => line.includes(query))
        .slice(0, limit);
    },
    async read(scopeId) {
      return bodies.get(scopeId) ?? "";
    },
    async readHead(scopeId) {
      return { content: bodies.get(scopeId) ?? "", revision: "revision-1", updatedAt: 1_799_999_999_000 };
    },
    async replace(scopeId, content) {
      bodies.set(scopeId, content);
    },
    async purge(scopeId) {
      bodies.delete(scopeId);
    },
  };
}

async function start() {
  const memory = fakeMemory();
  const auditLog = createAuditLog();
  const server = createMemoryHttpService({
    memory,
    auditLog,
    integrationId: "wulo-work",
    signingSecret: SECRET,
    scopeTokenSecret: SCOPE_TOKEN_SECRET,
    allowedScopeKinds: new Set(["personal"]),
    allowedScopePrefixes: ["personal:7:user:"],
    now: () => 1_800_000_000_000,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { memory, auditLog, base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function post(base: string, path: string, body: Record<string, unknown>, signed = true): Promise<Response> {
  const raw = JSON.stringify(body);
  const headers = signed
    ? signedRequestHeaders(SECRET, "POST", path, raw, { "content-type": "application/json" }, 1_800_000_000)
    : { "content-type": "application/json" };
  return fetch(`${base}${path}`, { method: "POST", headers, body: raw });
}

test("memory service health is public and checks its store", async () => {
  const service = await start();
  try {
    const response = await fetch(`${service.base}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await service.close();
  }
});

test("memory service rejects unsigned and out-of-scope requests", async () => {
  const service = await start();
  try {
    const unsigned = await post(
      service.base,
      "/v1/memory/query",
      { operationId: "op-1", scopeId: "personal:7:user:123", query: "fact" },
      false,
    );
    assert.equal(unsigned.status, 401);

    const forbidden = await post(service.base, "/v1/memory/query", {
      operationId: "op-2",
      scopeId: "personal:8:user:123",
      query: "fact",
    });
    assert.equal(forbidden.status, 403);
  } finally {
    await service.close();
  }
});

test("memory service captures once, returns the same retry receipt, and audits service attribution", async () => {
  const service = await start();
  const body = {
    operationId: "turn-123",
    scopeId: "personal:7:user:123",
    facts: ["Prefers terse replies"],
    capturedAt: 1_799_999_999_000,
  };
  try {
    const first = await post(service.base, "/v1/memory/capture", body);
    const retry = await post(service.base, "/v1/memory/capture", body);
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), await first.json());
    assert.equal(service.memory.captures.length, 1);
    assert.equal(service.memory.captures[0]?.author, "service:wulo-work");

    const events = await service.auditLog.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.principalId, "service:wulo-work");
    assert.equal(events[0]?.action, "memory.integration.capture");
  } finally {
    await service.close();
  }
});

test("memory service rejects operation reuse with a different capture", async () => {
  const service = await start();
  try {
    const first = await post(service.base, "/v1/memory/capture", {
      operationId: "turn-456",
      scopeId: "personal:7:user:123",
      facts: ["First fact"],
      capturedAt: 1_799_999_999_000,
    });
    const conflict = await post(service.base, "/v1/memory/capture", {
      operationId: "turn-456",
      scopeId: "personal:7:user:123",
      facts: ["Changed fact"],
      capturedAt: 1_799_999_999_000,
    });
    assert.equal(first.status, 200);
    assert.equal(conflict.status, 409);
  } finally {
    await service.close();
  }
});

test("memory service returns bounded query results and audit correlation", async () => {
  const service = await start();
  try {
    await post(service.base, "/v1/memory/capture", {
      operationId: "seed-1",
      scopeId: "personal:7:user:123",
      facts: ["billing fact", "other fact"],
      capturedAt: 1_799_999_999_000,
    });
    const response = await post(service.base, "/v1/memory/query", {
      operationId: "query-1",
      scopeId: "personal:7:user:123",
      query: "billing",
      limit: 1,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      operationId: "query-1",
      scopeId: "personal:7:user:123",
      results: ["billing fact"],
    });
    assert.ok(
      (await service.auditLog.events()).some((event) => /^memory-operation:[a-f0-9]{64}$/.test(event.resource)),
    );
  } finally {
    await service.close();
  }
});

test("memory service returns bounded recall content with revision metadata", async () => {
  const service = await start();
  try {
    await post(service.base, "/v1/memory/capture", {
      operationId: "seed-read",
      scopeId: "personal:7:user:123",
      facts: ["Prefers terse replies"],
      capturedAt: 1_799_999_999_000,
    });
    const response = await post(service.base, "/v1/memory/read", {
      operationId: "read-1",
      scopeId: "personal:7:user:123",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      operationId: "read-1",
      scopeId: "personal:7:user:123",
      content: "Prefers terse replies",
      revision: "revision-1",
      updatedAt: 1_799_999_999_000,
    });
  } finally {
    await service.close();
  }
});

test("memory service routine audits use stable keyed labels without subject identifiers", async () => {
  const service = await start();
  const scopeId = "personal:7:user:alice@example.com";
  try {
    await post(service.base, "/v1/memory/capture", {
      operationId: "private-capture",
      scopeId,
      facts: ["Prefers terse replies"],
      capturedAt: 1_799_999_999_000,
    });
    await post(service.base, "/v1/memory/query", {
      operationId: "private-query",
      scopeId,
      query: "terse",
    });
    await post(service.base, "/v1/memory/read", {
      operationId: "private-read",
      scopeId,
    });

    const events = await service.auditLog.events();
    const scopeLabel = `personal:audit:${memoryScopeToken(SCOPE_TOKEN_SECRET, scopeId)}`;
    assert.deepEqual(
      events.map((event) => event.scopeLabel),
      [scopeLabel, scopeLabel, scopeLabel],
    );
    assert.doesNotMatch(JSON.stringify(events), /alice@example\.com|personal:7:user:/);
  } finally {
    await service.close();
  }
});

test("memory service audits distinct requests when an operation id is reused", async () => {
  const service = await start();
  try {
    for (const scopeId of ["personal:7:user:alice", "personal:7:user:bob"]) {
      const response = await post(service.base, "/v1/memory/read", {
        operationId: "reused-read",
        scopeId,
      });
      assert.equal(response.status, 200);
    }

    const events = (await service.auditLog.events()).filter((event) => event.action === "memory.integration.read");
    assert.equal(events.length, 2);
    assert.equal(new Set(events.map((event) => event.resource)).size, 2);
    assert.doesNotMatch(JSON.stringify(events), /personal:7:user:(?:alice|bob)|reused-read/);
  } finally {
    await service.close();
  }
});

test("memory service requires a stable capture timestamp for retry safety", async () => {
  const service = await start();
  try {
    const response = await post(service.base, "/v1/memory/capture", {
      operationId: "missing-time",
      scopeId: "personal:7:user:123",
      facts: ["Prefers terse replies"],
    });
    assert.equal(response.status, 400);
    assert.equal(service.memory.captures.length, 0);
  } finally {
    await service.close();
  }
});

test("memory service hard-erases once without retaining the subject scope in its receipt or audit", async () => {
  const service = await start();
  const scopeId = "personal:7:user:123";
  const erase = {
    operationId: "erase-1",
    scopeId,
    erasedAt: 1_800_000_001_000,
  };
  try {
    await post(service.base, "/v1/memory/capture", {
      operationId: "seed-erase",
      scopeId,
      facts: ["Prefers terse replies"],
      capturedAt: 1_799_999_999_000,
    });

    const first = await post(service.base, "/v1/memory/erase", erase);
    const retry = await post(service.base, "/v1/memory/erase", erase);
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    const firstBody = await first.json();
    const retryBody = await retry.json();
    assert.deepEqual(retryBody, firstBody);
    assert.equal(await service.memory.read(scopeId), "");

    const responseText = JSON.stringify(firstBody);
    assert.doesNotMatch(responseText, /personal:7:user:123/);
    const eraseEvents = (await service.auditLog.events()).filter(
      (event) => event.action === "memory.integration.erase",
    );
    assert.equal(eraseEvents.length, 1);
    assert.doesNotMatch(JSON.stringify(eraseEvents), /personal:7:user:123/);
    assert.match(eraseEvents[0]!.scopeLabel, /^personal:erased:[a-f0-9]+$/);
  } finally {
    await service.close();
  }
});

test("memory service rejects erase operation reuse with a changed timestamp", async () => {
  const service = await start();
  try {
    const first = await post(service.base, "/v1/memory/erase", {
      operationId: "erase-conflict",
      scopeId: "personal:7:user:123",
      erasedAt: 1_800_000_001_000,
    });
    const conflict = await post(service.base, "/v1/memory/erase", {
      operationId: "erase-conflict",
      scopeId: "personal:7:user:123",
      erasedAt: 1_800_000_002_000,
    });
    assert.equal(first.status, 200);
    assert.equal(conflict.status, 409);
  } finally {
    await service.close();
  }
});
