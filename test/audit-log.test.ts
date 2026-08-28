import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuditLog, type AuditEvent } from "../src/audit/audit-log.ts";
import { scopeId } from "../src/types.ts";

function ev(at: number, action: string, scope = scopeId("personal", "U1")): AuditEvent {
  return { at, principalId: "U1", action, resource: `r-${action}`, scopeLabel: scope };
}

test("events() returns everything oldest-first", async () => {
  const log = createAuditLog();
  log.record(ev(100, "grant"));
  log.record(ev(200, "revoke"));
  log.record(ev(300, "deploy"));
  assert.deepEqual(
    (await log.events()).map((e) => e.action),
    ["grant", "revoke", "deploy"],
  );
});

test("createAuditLog() is in-memory only (does NOT survive a restart)", async () => {
  const log = createAuditLog();
  log.record(ev(1, "grant"));
  assert.equal((await log.events()).length, 1);
  assert.equal((await createAuditLog().events()).length, 0);
});

test("tail returns the newest `limit` events, newest-first", async () => {
  const log = createAuditLog();
  for (let i = 1; i <= 5; i++) log.record(ev(i, `a${i}`));
  const got = await log.tail({ limit: 2 });
  assert.deepEqual(
    got.map((e) => e.action),
    ["a5", "a4"],
  );
});

test("tail scopeLabel filters to that scope", async () => {
  const log = createAuditLog();
  const s1 = scopeId("personal", "U1");
  const s2 = scopeId("channel", "C1");
  log.record(ev(1, "a", s1));
  log.record(ev(2, "b", s2));
  log.record(ev(3, "c", s1));
  const got = await log.tail({ limit: 10, scopeLabel: s1 });
  assert.deepEqual(
    got.map((e) => e.action),
    ["c", "a"],
  );
});

test("a just-recorded event is immediately visible to tail (read-your-write)", async () => {
  const log = createAuditLog();
  log.record(ev(1, "grant"));
  assert.deepEqual(
    (await log.tail({ limit: 10 })).map((e) => e.action),
    ["grant"],
  );
});

function matEv(at: number, resource: string): AuditEvent {
  return { at, principalId: "U1", action: "keychain.materialize", resource, scopeLabel: scopeId("org", "acme") };
}

test("tail resourceContains keeps only events whose resource includes the substring", async () => {
  const log = createAuditLog();
  log.record(matEv(1, "cred1 (grant abc123)"));
  log.record(matEv(2, "cred1 (owner-auth command)"));
  log.record(matEv(3, "cred2 (grant def456)"));
  const got = await log.tail({ limit: 10, resourceContains: "grant" });
  assert.deepEqual(
    got.map((e) => e.resource).sort(),
    ["cred1 (grant abc123)", "cred2 (grant def456)"],
  );
});

test("tallyByResource counts events per resource for one action only", async () => {
  const log = createAuditLog();
  log.record(matEv(1, "cred1 (grant abc123)"));
  log.record(matEv(2, "cred1 (grant abc123)"));
  log.record(matEv(3, "cred1 (owner-auth command)"));
  log.record(ev(4, "keychain.read"));
  const tally = await log.tallyByResource!("keychain.materialize");
  assert.equal(tally.get("cred1 (grant abc123)"), 2);
  assert.equal(tally.get("cred1 (owner-auth command)"), 1);
  assert.equal(tally.get("r-keychain.read"), undefined);
});
