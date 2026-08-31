import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  canonicalJson,
  createCronScheduleAuthority,
  createScheduleAuthoritySigner,
  parseScheduleDisableReceipt,
  parseScheduleFireReceipt,
  scheduledOccurrence,
  scheduleRunRequestSha256,
  scheduleRunRequestTemplate,
  scheduleRunRequestTemplateSha256,
  sha256Canonical,
  signScheduleDisableReceipt,
  signScheduleFireReceipt,
  type PersistedScheduleRunRequest,
  type QmScheduleDefinition,
} from "../src/cron/schedule-authority.ts";
import { scopeId, type Cron } from "../src/types.ts";

const { privateKey } = generateKeyPairSync("ed25519");
const signer = createScheduleAuthoritySigner({
  authorityRef: "qm:test:scheduler",
  issuerRef: "qm:test",
  keyId: "schedule-test-1",
  privateKey,
});

const daily: QmScheduleDefinition = {
  scheduleRef: "invoice-daily",
  cadence: "daily",
  timeZone: "America/Los_Angeles",
  localTime: "09:00",
  weeklyDay: null,
  monthlyDay: null,
  activeFrom: "2026-01-01",
  activeUntil: "2026-12-31",
};

const request = (fireKey = "cron:cron-1:1780329600000"): PersistedScheduleRunRequest => ({
  surface: "cron",
  actor: { id: "U1", type: "internal" },
  conversation: { kind: "dm", threadRef: "cron:cron-1:fire:abc", audience: [{ id: "U1", type: "internal" }] },
  origin: { kind: "automation" },
  text: "create the scheduled artifact",
  idempotencyKey: fireKey,
});

function fireSigningInput() {
  const persisted = request();
  return {
    profileRef: "profile:test:1",
    profileSha256: "1".repeat(64),
    scheduleRef: daily.scheduleRef,
    qmCronId: "cron-1",
    scheduleDefinitionSha256: sha256Canonical(daily),
    cronRevisionSha256: "2".repeat(64),
    cronStateRevision: 1,
    runRequestTemplateSha256: scheduleRunRequestTemplateSha256(persisted),
    fireKey: persisted.idempotencyKey,
    scheduledAt: "2026-06-01T16:00:00.000Z",
    firedAt: "2026-06-01T16:00:01.000Z",
    issuedAt: "2026-06-01T16:00:01.000Z",
    expiresAt: "2026-06-01T16:05:01.000Z",
    localOccurrence: {
      localDate: "2026-06-01",
      localTime: "09:00",
      timeZone: daily.timeZone,
      utcOffset: "-07:00",
    },
    runId: "run-1",
    sessionId: "session-1",
    threadRef: persisted.conversation.threadRef,
    runRequestSha256: scheduleRunRequestSha256(persisted),
  };
}

function fireReceipt() {
  return signScheduleFireReceipt(signer, fireSigningInput());
}

test("daily, weekly, and monthly definitions accept their inclusive boundary occurrences", () => {
  const dailyAt = Date.parse("2026-01-01T17:00:00.000Z");
  assert.equal(scheduledOccurrence(daily, dailyAt).eligible, true);
  assert.equal(scheduledOccurrence({ ...daily, cadence: "weekly", weeklyDay: 4 }, dailyAt).eligible, true);
  assert.equal(scheduledOccurrence({ ...daily, cadence: "monthly", monthlyDay: 1 }, dailyAt).eligible, true);
  assert.equal(scheduledOccurrence(daily, Date.parse("2026-12-31T17:00:00.000Z")).eligible, true);
  assert.equal(scheduledOccurrence(daily, Date.parse("2027-01-01T17:00:00.000Z")).eligible, false);
});

test("both UTC instants in a repeated fall-back minute are ineligible", () => {
  const folded = { ...daily, localTime: "01:30" };
  for (const instant of ["2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z"]) {
    assert.deepEqual(scheduledOccurrence(folded, Date.parse(instant)), { eligible: false, reason: "ambiguous" });
  }
  const sevenHourFold = {
    ...daily,
    timeZone: "Antarctica/Vostok",
    localTime: "17:00",
    activeFrom: "1994-01-31",
    activeUntil: "1994-01-31",
  };
  for (const instant of ["1994-01-31T10:00:00.000Z", "1994-01-31T17:00:00.000Z"]) {
    assert.deepEqual(scheduledOccurrence(sevenHourFold, Date.parse(instant)), {
      eligible: false,
      reason: "ambiguous",
    });
  }
});

test("no UTC instant maps to a spring-forward gap minute", () => {
  const gap = { ...daily, localTime: "02:30" };
  const matches = Array.from(
    { length: 24 * 60 },
    (_, minute) => Date.parse("2026-03-08T00:00:00.000Z") + minute * 60_000,
  )
    .map((instant) => scheduledOccurrence(gap, instant))
    .filter((result) => result.eligible);
  assert.deepEqual(matches, []);
});

test("run request templates retain every value except the two domain-marked identities", () => {
  const persisted = request();
  const template = scheduleRunRequestTemplate(persisted);
  assert.notEqual(template.conversation.threadRef, persisted.conversation.threadRef);
  assert.notEqual(template.idempotencyKey, persisted.idempotencyKey);
  assert.deepEqual(
    { ...template, conversation: persisted.conversation, idempotencyKey: persisted.idempotencyKey },
    persisted,
  );
});

test("cron configuration generation changes the immutable revision even when values repeat", () => {
  const persisted = request();
  const cron: Cron = {
    id: "cron-1",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    enabled: true,
    createdAt: 1,
    action: "create the scheduled artifact",
    schedule: { cron: "0 9 * * *", timezone: daily.timeZone },
  };
  const base = {
    contractVersion: 1 as const,
    authorityRef: signer.authorityRef,
    issuerRef: signer.issuerRef,
    keyId: signer.keyId,
    profileRef: "profile:test:1",
    profileSha256: "1".repeat(64),
    scheduleDefinition: daily,
    runRequestTemplateSha256: scheduleRunRequestTemplateSha256(persisted),
    receiptLifetimeMs: 300_000,
  };
  const first = createCronScheduleAuthority(cron, base, 1, 1);
  const second = createCronScheduleAuthority(cron, base, 2, 1);
  assert.notEqual(first.cronRevisionSha256, second.cronRevisionSha256);
  assert.equal(first.scheduleDefinitionSha256, second.scheduleDefinitionSha256);
});

test("schedule authority is restricted to durable action runs", () => {
  const persisted = request();
  const base = {
    contractVersion: 1 as const,
    authorityRef: signer.authorityRef,
    issuerRef: signer.issuerRef,
    keyId: signer.keyId,
    profileRef: "profile:test:1",
    profileSha256: "1".repeat(64),
    scheduleDefinition: daily,
    runRequestTemplateSha256: scheduleRunRequestTemplateSha256(persisted),
    receiptLifetimeMs: 300_000,
  };
  const common: Cron = {
    id: "cron-1",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    enabled: true,
    createdAt: 1,
    schedule: { cron: "0 9 * * *", timezone: daily.timeZone },
  };
  assert.throws(() => createCronScheduleAuthority({ ...common, message: "deliver" }, base), /action-only/u);
  assert.throws(
    () => createCronScheduleAuthority({ ...common, action: "run", message: "deliver" }, base),
    /action-only/u,
  );
  assert.throws(
    () => createCronScheduleAuthority({ ...common, action: "run", schedule: { everyMs: 60_000 } }, base),
    /schedule/u,
  );
});

test("signing rejects runtime field injection and wrong types before signer identity can be overridden", () => {
  const valid = fireSigningInput();
  for (const injected of [
    { ...valid, authorityRef: "qm:forged" },
    { ...valid, issuerRef: ["qm:forged"] },
    { ...valid, keyId: "forged-key" },
  ]) {
    assert.throws(
      () => signScheduleFireReceipt(signer, injected as Parameters<typeof signScheduleFireReceipt>[1]),
      /shape/u,
    );
  }
  assert.throws(
    () =>
      signScheduleFireReceipt(signer, {
        ...valid,
        profileRef: 7,
      } as unknown as Parameters<typeof signScheduleFireReceipt>[1]),
    /profileRef/u,
  );
  assert.throws(
    () =>
      signScheduleFireReceipt(signer, {
        ...valid,
        localOccurrence: { ...valid.localOccurrence, timeZone: [daily.timeZone] },
      } as unknown as Parameters<typeof signScheduleFireReceipt>[1]),
    /localOccurrence/u,
  );
  assert.equal(fireReceipt().authorityRef, signer.authorityRef);
});

test("signing rejects accessor and proxy inputs without evaluating attacker code", () => {
  let accessorReads = 0;
  const accessorInput = { ...fireSigningInput() };
  Object.defineProperty(accessorInput, "profileRef", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "profile:forged:1";
    },
  });
  assert.throws(
    () => signScheduleFireReceipt(signer, accessorInput as Parameters<typeof signScheduleFireReceipt>[1]),
    /data property/u,
  );
  assert.equal(accessorReads, 0);
  let proxyTraps = 0;
  const proxyInput = new Proxy(fireSigningInput(), {
    getPrototypeOf() {
      proxyTraps += 1;
      return Object.prototype;
    },
  });
  assert.throws(() => signScheduleFireReceipt(signer, proxyInput), /proxy/u);
  assert.equal(proxyTraps, 0);
});

test("fire receipt canonical bytes verify and any signed-field change fails closed", () => {
  const receipt = fireReceipt();
  const bytes = Buffer.from(canonicalJson(receipt), "utf8");
  assert.deepEqual(parseScheduleFireReceipt(bytes, signer.publicKey), receipt);
  const tampered = { ...receipt, runId: "run-2" };
  assert.throws(
    () => parseScheduleFireReceipt(Buffer.from(canonicalJson(tampered), "utf8"), signer.publicKey),
    /receiptSha256/u,
  );
  const selfHashed = { ...tampered };
  const { receiptSha256: _digest, signature: _signature, ...unsigned } = selfHashed;
  selfHashed.receiptSha256 = sha256Canonical(unsigned);
  assert.throws(
    () => parseScheduleFireReceipt(Buffer.from(canonicalJson(selfHashed), "utf8"), signer.publicKey),
    /signature/u,
  );
  const foreign = createScheduleAuthoritySigner({
    authorityRef: signer.authorityRef,
    issuerRef: signer.issuerRef,
    keyId: signer.keyId,
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  assert.throws(() => parseScheduleFireReceipt(bytes, foreign.publicKey), /signature/u);
});

test("every fire receipt field and nested occurrence field is integrity-bound", () => {
  const receipt = fireReceipt();
  const alteredString = (value: string): string => `${value.slice(0, -1)}${value.endsWith("a") ? "b" : "a"}`;
  for (const key of Object.keys(receipt) as Array<keyof typeof receipt>) {
    const original = receipt[key];
    let changed: unknown;
    if (typeof original === "number") changed = original + 1;
    else if (typeof original === "string") changed = alteredString(original);
    else changed = { ...original, localDate: "2026-06-02" };
    const tampered = { ...receipt, [key]: changed };
    assert.throws(
      () => parseScheduleFireReceipt(Buffer.from(canonicalJson(tampered), "utf8"), signer.publicKey),
      Error,
      key,
    );
  }
  for (const key of Object.keys(receipt.localOccurrence) as Array<keyof typeof receipt.localOccurrence>) {
    const tampered = {
      ...receipt,
      localOccurrence: {
        ...receipt.localOccurrence,
        [key]: alteredString(receipt.localOccurrence[key]),
      },
    };
    assert.throws(
      () => parseScheduleFireReceipt(Buffer.from(canonicalJson(tampered), "utf8"), signer.publicKey),
      Error,
      key,
    );
  }
});

test("raw receipt parsing rejects noncanonical, duplicate, invalid UTF-8, BOM, and oversized bytes", () => {
  const receipt = fireReceipt();
  const canonical = canonicalJson(receipt);
  assert.throws(() => parseScheduleFireReceipt(Buffer.from(` ${canonical}`, "utf8"), signer.publicKey), /canonical/u);
  assert.throws(
    () =>
      parseScheduleFireReceipt(
        Buffer.from(canonical.replace("{", '{"contractType":"duplicate",'), "utf8"),
        signer.publicKey,
      ),
    /canonical/u,
  );
  assert.throws(
    () =>
      parseScheduleFireReceipt(
        Buffer.from(canonical.replace('"localDate":', '"localDate":"2026-06-01","localDate":'), "utf8"),
        signer.publicKey,
      ),
    /canonical/u,
  );
  assert.throws(() => parseScheduleFireReceipt(Uint8Array.from([0xc3, 0x28]), signer.publicKey), /UTF-8/u);
  assert.throws(
    () => parseScheduleFireReceipt(Buffer.from(`\uFEFF${canonical}`, "utf8"), signer.publicKey),
    /byte-order/u,
  );
  assert.throws(() => parseScheduleFireReceipt(Buffer.alloc(16 * 1024 + 1, 0x20), signer.publicKey), /length/u);
  assert.throws(
    () =>
      parseScheduleFireReceipt(
        Buffer.from(canonicalJson({ ...receipt, signature: `${receipt.signature}=` }), "utf8"),
        signer.publicKey,
      ),
    /signature/u,
  );
  assert.throws(
    () =>
      parseScheduleFireReceipt(
        Buffer.from(canonicalJson({ ...receipt, scheduledAt: "2026-06-01T16:00:00Z" }), "utf8"),
        signer.publicKey,
      ),
    /scheduledAt/u,
  );
});

test("wrong-type proxy receipt input is rejected without invoking proxy traps", () => {
  let traps = 0;
  const bytes = new Proxy(
    {},
    {
      getPrototypeOf() {
        traps += 1;
        return Object.prototype;
      },
    },
  );
  assert.throws(() => parseScheduleFireReceipt(bytes as unknown as Uint8Array, signer.publicKey), /UTF-8 bytes/u);
  assert.equal(traps, 0);
  let tagReads = 0;
  let byteLengthReads = 0;
  const canonical = Uint8Array.from(Buffer.from(canonicalJson(fireReceipt()), "utf8"));
  Object.defineProperty(canonical, Symbol.toStringTag, {
    get() {
      tagReads += 1;
      return "forged";
    },
  });
  Object.defineProperty(canonical, "byteLength", {
    get() {
      byteLengthReads += 1;
      return 0;
    },
  });
  assert.equal(parseScheduleFireReceipt(canonical, signer.publicKey).runId, "run-1");
  assert.equal(tagReads, 0);
  assert.equal(byteLengthReads, 0);
});

test("disable receipts bind an inclusive activeUntil transition and chronology", () => {
  const input = {
    profileRef: "profile:test:1",
    profileSha256: "1".repeat(64),
    scheduleRef: daily.scheduleRef,
    qmCronId: "cron-1",
    scheduleDefinitionSha256: sha256Canonical(daily),
    cronRevisionSha256: "2".repeat(64),
    lastEligibleScheduledAt: "2026-12-31T17:00:00.000Z",
    firstRejectedScheduledAt: "2027-01-01T17:00:00.000Z",
    disabledAt: "2027-01-01T17:00:01.000Z",
    priorStateRevision: 1,
    resultingStateRevision: 2,
  };
  const receipt = signScheduleDisableReceipt(signer, input);
  assert.deepEqual(parseScheduleDisableReceipt(Buffer.from(canonicalJson(receipt), "utf8"), signer.publicKey), receipt);
  assert.throws(
    () =>
      parseScheduleDisableReceipt(
        Buffer.from(canonicalJson({ ...receipt, resultingStateRevision: 3 }), "utf8"),
        signer.publicKey,
      ),
    /transition/u,
  );
  assert.throws(
    () =>
      parseScheduleDisableReceipt(
        Buffer.from(canonicalJson({ ...receipt, receiptSha256: "0".repeat(64) }), "utf8"),
        signer.publicKey,
      ),
    /receiptSha256/u,
  );
  const changed = { ...receipt, disabledAt: "2027-01-01T17:00:02.000Z" };
  const { receiptSha256: _digest, signature: _signature, ...unsigned } = changed;
  changed.receiptSha256 = sha256Canonical(unsigned);
  assert.throws(
    () => parseScheduleDisableReceipt(Buffer.from(canonicalJson(changed), "utf8"), signer.publicKey),
    /signature/u,
  );
  assert.throws(
    () =>
      parseScheduleDisableReceipt(
        Buffer.from(canonicalJson({ ...receipt, lastEligibleScheduledAt: receipt.firstRejectedScheduledAt }), "utf8"),
        signer.publicKey,
      ),
    /chronology/u,
  );
  assert.throws(
    () =>
      signScheduleDisableReceipt(signer, {
        ...input,
        authorityRef: "qm:forged",
      } as Parameters<typeof signScheduleDisableReceipt>[1]),
    /shape/u,
  );
  assert.throws(
    () =>
      signScheduleDisableReceipt(signer, {
        ...input,
        scheduleRef: [daily.scheduleRef],
      } as unknown as Parameters<typeof signScheduleDisableReceipt>[1]),
    /scheduleRef/u,
  );
});
