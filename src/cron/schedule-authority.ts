import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
  type PrivateKeyInput,
  type JsonWebKeyInput,
} from "node:crypto";
import { types as utilTypes } from "node:util";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import type { Cron, ScopeId } from "../types.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const LOCAL_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const TIMESTAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const UTC_OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const THREAD_MARKER = "qm.schedule-run.thread-ref.v1";
const IDEMPOTENCY_MARKER = "qm.schedule-run.idempotency-key.v1";
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;

export type ScheduleCadence = "daily" | "weekly" | "monthly";

export interface QmScheduleDefinition {
  scheduleRef: string;
  cadence: ScheduleCadence;
  timeZone: string;
  localTime: string;
  weeklyDay: number | null;
  monthlyDay: number | null;
  activeFrom: string;
  activeUntil: string;
}

export interface CronScheduleAuthority {
  contractVersion: 1;
  authorityRef: string;
  issuerRef: string;
  keyId: string;
  profileRef: string;
  profileSha256: string;
  scheduleDefinition: QmScheduleDefinition;
  scheduleDefinitionSha256: string;
  configurationGeneration: number;
  cronRevisionSha256: string;
  runRequestTemplateSha256: string;
  stateRevision: number;
  receiptLifetimeMs: number;
  disabledReason?: "active_until_elapsed";
}

export type CronScheduleAuthorityInput = Omit<
  CronScheduleAuthority,
  "scheduleDefinitionSha256" | "configurationGeneration" | "cronRevisionSha256" | "stateRevision" | "disabledReason"
>;

const CRON_SCHEDULE_AUTHORITY_INPUT_KEYS = [
  "contractVersion",
  "authorityRef",
  "issuerRef",
  "keyId",
  "profileRef",
  "profileSha256",
  "scheduleDefinition",
  "runRequestTemplateSha256",
  "receiptLifetimeMs",
] as const;

const CRON_SCHEDULE_AUTHORITY_KEYS = [
  ...CRON_SCHEDULE_AUTHORITY_INPUT_KEYS,
  "scheduleDefinitionSha256",
  "configurationGeneration",
  "cronRevisionSha256",
  "stateRevision",
] as const;

export interface QmCronConfigurationRevision {
  contractType: "qm-cron-configuration-revision";
  contractVersion: 1;
  digestRevision: "QmCronConfigurationRevision.sha256.v1";
  qmCronId: string;
  configurationGeneration: number;
  owner: string;
  ownerScopeId: string;
  createdBy: string;
  titleSha256: string;
  actionSha256: string;
  messageSha256: string;
  scheduleDefinitionSha256: string;
  runAs: Cron["runAs"] | null;
  destinationSha256: string;
  membersSha256: string;
  unattendedGrantsSha256: string;
  recipientConsentPolicySha256: string;
  runRequestTemplateSha256: string;
}

export interface QmScheduleLocalOccurrence {
  localDate: string;
  localTime: string;
  timeZone: string;
  utcOffset: string;
}

export interface QmScheduleFireReceipt {
  contractType: "qm-schedule-fire-receipt";
  contractVersion: 1;
  digestRevision: "QmScheduleFireReceipt.sha256.v1";
  signatureDomain: "qm.schedule-fire.v1";
  authorityRef: string;
  issuerRef: string;
  keyId: string;
  algorithm: "Ed25519";
  profileRef: string;
  profileSha256: string;
  scheduleRef: string;
  qmCronId: string;
  scheduleDefinitionSha256: string;
  cronRevisionSha256: string;
  cronStateRevision: number;
  runRequestTemplateSha256: string;
  scheduleState: "active";
  fireMode: "scheduled";
  fireKey: string;
  scheduledAt: string;
  firedAt: string;
  issuedAt: string;
  expiresAt: string;
  localOccurrence: QmScheduleLocalOccurrence;
  runId: string;
  sessionId: string;
  threadRef: string;
  runRequestSha256: string;
  receiptSha256: string;
  signature: string;
}

export interface QmScheduleDisableReceipt {
  contractType: "qm-schedule-disable-receipt";
  contractVersion: 1;
  digestRevision: "QmScheduleDisableReceipt.sha256.v1";
  signatureDomain: "qm.schedule-disable.v1";
  authorityRef: string;
  issuerRef: string;
  keyId: string;
  algorithm: "Ed25519";
  profileRef: string;
  profileSha256: string;
  scheduleRef: string;
  qmCronId: string;
  scheduleDefinitionSha256: string;
  cronRevisionSha256: string;
  reason: "active_until_elapsed";
  lastEligibleScheduledAt: string | null;
  firstRejectedScheduledAt: string;
  disabledAt: string;
  priorStateRevision: number;
  resultingStateRevision: number;
  receiptSha256: string;
  signature: string;
}

const FIRE_SIGNING_INPUT_KEYS = [
  "profileRef",
  "profileSha256",
  "scheduleRef",
  "qmCronId",
  "scheduleDefinitionSha256",
  "cronRevisionSha256",
  "cronStateRevision",
  "runRequestTemplateSha256",
  "fireKey",
  "scheduledAt",
  "firedAt",
  "issuedAt",
  "expiresAt",
  "localOccurrence",
  "runId",
  "sessionId",
  "threadRef",
  "runRequestSha256",
] as const;

const DISABLE_SIGNING_INPUT_KEYS = [
  "profileRef",
  "profileSha256",
  "scheduleRef",
  "qmCronId",
  "scheduleDefinitionSha256",
  "cronRevisionSha256",
  "lastEligibleScheduledAt",
  "firstRejectedScheduledAt",
  "disabledAt",
  "priorStateRevision",
  "resultingStateRevision",
] as const;

export interface ScheduleAuthoritySigner {
  authorityRef: string;
  issuerRef: string;
  keyId: string;
  privateKey: KeyObject;
  publicKey: { kty: "OKP"; crv: "Ed25519"; x: string };
}

export type PersistedScheduleRunRequest = OrchestratorInput & { idempotencyKey: string };

export interface ScheduledTurnContext {
  cronId: string;
  scheduledAt: number;
  ownerScopeId: ScopeId;
  onClaim(status: "enqueued" | "deduped" | "disabled" | "skipped"): void;
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TypeError(`${field} is invalid`);
}

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${field} is invalid`);
}

function assertPlain(value: object, field: string): void {
  if (utilTypes.isProxy(value)) throw new TypeError(`${field} must not be a proxy`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`${field} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${field} must not contain symbols`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || descriptor.get || descriptor.set) {
      throw new TypeError(`${field}.${key} must be an enumerable data property`);
    }
  }
}

function assertExactKeys(value: object, keys: readonly string[], field: string): void {
  assertPlain(value, field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} has an invalid shape`);
  }
}

function canonicalValue(value: unknown, field: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) throw new TypeError(`${field} contains a lone surrogate`);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new TypeError(`${field} must be a safe integer`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`${field} is not canonical JSON`);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${field} must not contain symbols`);
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new TypeError(`${field} must be a dense array without extra properties`);
    }
    return `[${value.map((entry, index) => canonicalValue(entry, `${field}[${index}]`)).join(",")}]`;
  }
  assertPlain(value, field);
  const entries = Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalValue((value as Record<string, unknown>)[key], `${field}.${key}`)}`,
    );
  return `{${entries.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value, "value");
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !LOCAL_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

export function validateScheduleDefinition(value: QmScheduleDefinition): QmScheduleDefinition {
  assertPlain(value, "scheduleDefinition");
  if (
    Object.keys(value).sort().join(",") !==
    "activeFrom,activeUntil,cadence,localTime,monthlyDay,scheduleRef,timeZone,weeklyDay"
  ) {
    throw new TypeError("scheduleDefinition has an invalid shape");
  }
  assertIdentifier(value.scheduleRef, "scheduleDefinition.scheduleRef");
  if (!(["daily", "weekly", "monthly"] as const).includes(value.cadence)) {
    throw new TypeError("scheduleDefinition.cadence is invalid");
  }
  if (typeof value.localTime !== "string" || !LOCAL_TIME.test(value.localTime)) {
    throw new TypeError("scheduleDefinition.localTime is invalid");
  }
  if (!validDate(value.activeFrom) || !validDate(value.activeUntil) || value.activeFrom > value.activeUntil) {
    throw new TypeError("scheduleDefinition active window is invalid");
  }
  if (typeof value.timeZone !== "string" || value.timeZone.length === 0) {
    throw new TypeError("scheduleDefinition.timeZone is invalid");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.timeZone }).format(0);
  } catch {
    throw new TypeError("scheduleDefinition.timeZone is invalid");
  }
  const weekly = Number.isSafeInteger(value.weeklyDay) && value.weeklyDay! >= 0 && value.weeklyDay! <= 6;
  const monthly = Number.isSafeInteger(value.monthlyDay) && value.monthlyDay! >= 1 && value.monthlyDay! <= 28;
  if (value.cadence === "daily" && (value.weeklyDay !== null || value.monthlyDay !== null)) {
    throw new TypeError("daily schedule selectors must be null");
  }
  if (value.cadence === "weekly" && (!weekly || value.monthlyDay !== null)) {
    throw new TypeError("weekly schedule selectors are invalid");
  }
  if (value.cadence === "monthly" && (value.weeklyDay !== null || !monthly)) {
    throw new TypeError("monthly schedule selectors are invalid");
  }
  return structuredClone(value);
}

export function cronExpressionForSchedule(value: QmScheduleDefinition): string {
  const checked = validateScheduleDefinition(value);
  const [hour, minute] = checked.localTime.split(":").map(Number);
  if (checked.cadence === "daily") return `${minute} ${hour} * * *`;
  if (checked.cadence === "weekly") return `${minute} ${hour} * * ${checked.weeklyDay}`;
  return `${minute} ${hour} ${checked.monthlyDay} * *`;
}

function hashNullable(value: unknown): string {
  return sha256Canonical(value === undefined ? null : value);
}

export function cronConfigurationRevision(
  cron: Pick<
    Cron,
    | "id"
    | "owner"
    | "ownerScopeId"
    | "createdBy"
    | "title"
    | "action"
    | "message"
    | "runAs"
    | "destination"
    | "members"
    | "unattendedGrants"
    | "recipientConsent"
  >,
  authority: Pick<
    CronScheduleAuthority,
    "configurationGeneration" | "scheduleDefinitionSha256" | "runRequestTemplateSha256"
  >,
): QmCronConfigurationRevision {
  if (!Number.isSafeInteger(authority.configurationGeneration) || authority.configurationGeneration <= 0) {
    throw new TypeError("configurationGeneration must be a positive safe integer");
  }
  assertDigest(authority.scheduleDefinitionSha256, "scheduleDefinitionSha256");
  assertDigest(authority.runRequestTemplateSha256, "runRequestTemplateSha256");
  return {
    contractType: "qm-cron-configuration-revision",
    contractVersion: 1,
    digestRevision: "QmCronConfigurationRevision.sha256.v1",
    qmCronId: cron.id,
    configurationGeneration: authority.configurationGeneration,
    owner: cron.owner,
    ownerScopeId: cron.ownerScopeId,
    createdBy: cron.createdBy,
    titleSha256: hashNullable(cron.title),
    actionSha256: hashNullable(cron.action),
    messageSha256: hashNullable(cron.message),
    scheduleDefinitionSha256: authority.scheduleDefinitionSha256,
    runAs: cron.runAs ?? null,
    destinationSha256: hashNullable(cron.destination),
    membersSha256: hashNullable(cron.members),
    unattendedGrantsSha256: hashNullable(cron.unattendedGrants),
    recipientConsentPolicySha256: hashNullable(cron.recipientConsent),
    runRequestTemplateSha256: authority.runRequestTemplateSha256,
  };
}

function validateCronScheduleAuthority(value: CronScheduleAuthority): CronScheduleAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("scheduleAuthority is invalid");
  }
  assertPlain(value, "scheduleAuthority");
  const hasDisabledReason = Object.prototype.hasOwnProperty.call(value, "disabledReason");
  assertExactKeys(
    value,
    hasDisabledReason ? [...CRON_SCHEDULE_AUTHORITY_KEYS, "disabledReason"] : CRON_SCHEDULE_AUTHORITY_KEYS,
    "scheduleAuthority",
  );
  if (value.contractVersion !== 1) throw new TypeError("schedule authority contractVersion is invalid");
  assertIdentifier(value.authorityRef, "scheduleAuthority.authorityRef");
  assertIdentifier(value.issuerRef, "scheduleAuthority.issuerRef");
  assertIdentifier(value.keyId, "scheduleAuthority.keyId");
  assertIdentifier(value.profileRef, "scheduleAuthority.profileRef");
  assertDigest(value.profileSha256, "scheduleAuthority.profileSha256");
  assertDigest(value.scheduleDefinitionSha256, "scheduleAuthority.scheduleDefinitionSha256");
  assertDigest(value.cronRevisionSha256, "scheduleAuthority.cronRevisionSha256");
  assertDigest(value.runRequestTemplateSha256, "scheduleAuthority.runRequestTemplateSha256");
  if (!Number.isSafeInteger(value.configurationGeneration) || value.configurationGeneration <= 0) {
    throw new TypeError("scheduleAuthority.configurationGeneration must be a positive safe integer");
  }
  if (!Number.isSafeInteger(value.stateRevision) || value.stateRevision <= 0) {
    throw new TypeError("scheduleAuthority.stateRevision must be a positive safe integer");
  }
  if (!Number.isSafeInteger(value.receiptLifetimeMs) || value.receiptLifetimeMs <= 0) {
    throw new TypeError("scheduleAuthority.receiptLifetimeMs must be a positive safe integer");
  }
  if (hasDisabledReason && value.disabledReason !== "active_until_elapsed") {
    throw new TypeError("scheduleAuthority.disabledReason is invalid");
  }
  const scheduleDefinition = validateScheduleDefinition(value.scheduleDefinition);
  if (sha256Canonical(scheduleDefinition) !== value.scheduleDefinitionSha256) {
    throw new TypeError("scheduleDefinitionSha256 does not match scheduleDefinition");
  }
  return structuredClone({ ...value, scheduleDefinition });
}

export function withCronRevision(cron: Cron, authority: CronScheduleAuthority): CronScheduleAuthority {
  const checked = validateCronScheduleAuthority(authority);
  const scheduleDefinition = checked.scheduleDefinition;
  if (
    cron.schedule.cron !== cronExpressionForSchedule(scheduleDefinition) ||
    cron.schedule.timezone !== scheduleDefinition.timeZone
  ) {
    throw new TypeError("cron schedule does not match its authority definition");
  }
  const scheduleDefinitionSha256 = sha256Canonical(scheduleDefinition);
  if (checked.scheduleDefinitionSha256 !== scheduleDefinitionSha256) {
    throw new TypeError("scheduleDefinitionSha256 does not match scheduleDefinition");
  }
  return {
    ...checked,
    cronRevisionSha256: sha256Canonical(cronConfigurationRevision(cron, checked)),
  };
}

export function createCronScheduleAuthority(
  cron: Cron,
  input: CronScheduleAuthorityInput,
  configurationGeneration = 1,
  stateRevision = 1,
): CronScheduleAuthority {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("scheduleAuthority is invalid");
  }
  assertExactKeys(input, CRON_SCHEDULE_AUTHORITY_INPUT_KEYS, "scheduleAuthority");
  if (typeof cron.action !== "string" || cron.action.trim() === "" || cron.message !== undefined) {
    throw new TypeError("schedule authority requires an action-only cron");
  }
  if (input.contractVersion !== 1) throw new TypeError("schedule authority contractVersion is invalid");
  assertIdentifier(input.authorityRef, "scheduleAuthority.authorityRef");
  assertIdentifier(input.issuerRef, "scheduleAuthority.issuerRef");
  assertIdentifier(input.keyId, "scheduleAuthority.keyId");
  assertIdentifier(input.profileRef, "scheduleAuthority.profileRef");
  assertDigest(input.profileSha256, "scheduleAuthority.profileSha256");
  assertDigest(input.runRequestTemplateSha256, "scheduleAuthority.runRequestTemplateSha256");
  if (!Number.isSafeInteger(input.receiptLifetimeMs) || input.receiptLifetimeMs <= 0) {
    throw new TypeError("scheduleAuthority.receiptLifetimeMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(configurationGeneration) || configurationGeneration <= 0) {
    throw new TypeError("scheduleAuthority.configurationGeneration must be a positive safe integer");
  }
  if (!Number.isSafeInteger(stateRevision) || stateRevision <= 0) {
    throw new TypeError("scheduleAuthority.stateRevision must be a positive safe integer");
  }
  const authority: CronScheduleAuthority = {
    ...structuredClone(input),
    scheduleDefinition: validateScheduleDefinition(input.scheduleDefinition),
    scheduleDefinitionSha256: sha256Canonical(input.scheduleDefinition),
    configurationGeneration,
    cronRevisionSha256: "0".repeat(64),
    stateRevision,
  };
  return withCronRevision(cron, authority);
}

export function scheduleRunRequestTemplate(request: PersistedScheduleRunRequest): PersistedScheduleRunRequest {
  const snapshot = structuredClone(request);
  return {
    ...snapshot,
    conversation: { ...snapshot.conversation, threadRef: THREAD_MARKER },
    idempotencyKey: IDEMPOTENCY_MARKER,
  };
}

export function scheduleRunRequestTemplateSha256(request: PersistedScheduleRunRequest): string {
  return sha256Canonical(scheduleRunRequestTemplate(request));
}

export function scheduleRunRequestSha256(request: PersistedScheduleRunRequest): string {
  return sha256Canonical(request);
}

export function scheduleLocalOccurrence(at: number, timeZone: string): QmScheduleLocalOccurrence {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? "";
  const offset = part("timeZoneName").replace(/^GMT/u, "");
  return {
    localDate: `${part("year")}-${part("month")}-${part("day")}`,
    localTime: `${part("hour")}:${part("minute")}`,
    timeZone,
    utcOffset: offset === "" ? "+00:00" : offset,
  };
}

function occurrenceCount(at: number, occurrence: QmScheduleLocalOccurrence): number {
  let count = 0;
  for (let candidate = at - 30 * 60 * 60_000; candidate <= at + 30 * 60 * 60_000; candidate += 60_000) {
    const local = scheduleLocalOccurrence(candidate, occurrence.timeZone);
    if (local.localDate === occurrence.localDate && local.localTime === occurrence.localTime) count += 1;
  }
  return count;
}

export function scheduledOccurrence(
  definition: QmScheduleDefinition,
  scheduledAt: number,
):
  | { eligible: true; occurrence: QmScheduleLocalOccurrence }
  | { eligible: false; reason: "outside_window" | "selector" | "ambiguous" } {
  const checked = validateScheduleDefinition(definition);
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt < 0 || scheduledAt % 60_000 !== 0) {
    throw new TypeError("scheduledAt must identify an exact UTC minute");
  }
  const occurrence = scheduleLocalOccurrence(scheduledAt, checked.timeZone);
  if (occurrence.localDate < checked.activeFrom || occurrence.localDate > checked.activeUntil) {
    return { eligible: false, reason: "outside_window" };
  }
  if (occurrence.localTime !== checked.localTime) return { eligible: false, reason: "selector" };
  const [year, month, day] = occurrence.localDate.split("-").map(Number);
  const weeklyDay = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  if (checked.cadence === "weekly" && checked.weeklyDay !== weeklyDay) {
    return { eligible: false, reason: "selector" };
  }
  if (checked.cadence === "monthly" && checked.monthlyDay !== day) {
    return { eligible: false, reason: "selector" };
  }
  if (occurrenceCount(scheduledAt, occurrence) !== 1) return { eligible: false, reason: "ambiguous" };
  return { eligible: true, occurrence };
}

export function createScheduleAuthoritySigner(input: {
  authorityRef: string;
  issuerRef: string;
  keyId: string;
  privateKey: PrivateKeyInput | JsonWebKeyInput | string | Buffer | KeyObject;
}): ScheduleAuthoritySigner {
  assertIdentifier(input.authorityRef, "authorityRef");
  assertIdentifier(input.issuerRef, "issuerRef");
  assertIdentifier(input.keyId, "keyId");
  const privateKey = input.privateKey instanceof KeyObject ? input.privateKey : createPrivateKey(input.privateKey);
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("schedule authority private key must be Ed25519");
  }
  const exported = createPublicKey(privateKey).export({ format: "jwk" });
  if (
    exported.kty !== "OKP" ||
    exported.crv !== "Ed25519" ||
    typeof exported.x !== "string" ||
    exported.x.length !== 43
  ) {
    throw new TypeError("schedule authority public key is invalid");
  }
  return Object.freeze({
    authorityRef: input.authorityRef,
    issuerRef: input.issuerRef,
    keyId: input.keyId,
    privateKey,
    publicKey: Object.freeze({ kty: "OKP", crv: "Ed25519", x: exported.x }),
  });
}

function signedReceipt<T extends Record<string, unknown>>(
  signer: ScheduleAuthoritySigner,
  domain: "qm.schedule-fire.v1" | "qm.schedule-disable.v1",
  fields: T,
): T & { receiptSha256: string; signature: string } {
  const receiptSha256 = sha256Canonical(fields);
  const signature = sign(null, Buffer.from(`${domain}\n${receiptSha256}`, "utf8"), signer.privateKey).toString(
    "base64url",
  );
  return { ...fields, receiptSha256, signature };
}

export function signScheduleFireReceipt(
  signer: ScheduleAuthoritySigner,
  input: Omit<
    QmScheduleFireReceipt,
    | "contractType"
    | "contractVersion"
    | "digestRevision"
    | "signatureDomain"
    | "authorityRef"
    | "issuerRef"
    | "keyId"
    | "algorithm"
    | "scheduleState"
    | "fireMode"
    | "receiptSha256"
    | "signature"
  >,
): QmScheduleFireReceipt {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("schedule-fire signing input is invalid");
  }
  assertExactKeys(input, FIRE_SIGNING_INPUT_KEYS, "schedule-fire signing input");
  const unsigned = {
    ...input,
    contractType: "qm-schedule-fire-receipt" as const,
    contractVersion: 1 as const,
    digestRevision: "QmScheduleFireReceipt.sha256.v1" as const,
    signatureDomain: "qm.schedule-fire.v1" as const,
    authorityRef: signer.authorityRef,
    issuerRef: signer.issuerRef,
    keyId: signer.keyId,
    algorithm: "Ed25519" as const,
    scheduleState: "active" as const,
    fireMode: "scheduled" as const,
  };
  assertScheduleFireUnsigned(unsigned);
  const receipt = signedReceipt(signer, "qm.schedule-fire.v1", structuredClone(unsigned));
  return parseScheduleFireReceipt(Buffer.from(canonicalJson(receipt), "utf8"), signer.publicKey);
}

export function signScheduleDisableReceipt(
  signer: ScheduleAuthoritySigner,
  input: Omit<
    QmScheduleDisableReceipt,
    | "contractType"
    | "contractVersion"
    | "digestRevision"
    | "signatureDomain"
    | "authorityRef"
    | "issuerRef"
    | "keyId"
    | "algorithm"
    | "reason"
    | "receiptSha256"
    | "signature"
  >,
): QmScheduleDisableReceipt {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("schedule-disable signing input is invalid");
  }
  assertExactKeys(input, DISABLE_SIGNING_INPUT_KEYS, "schedule-disable signing input");
  const unsigned = {
    ...input,
    contractType: "qm-schedule-disable-receipt" as const,
    contractVersion: 1 as const,
    digestRevision: "QmScheduleDisableReceipt.sha256.v1" as const,
    signatureDomain: "qm.schedule-disable.v1" as const,
    authorityRef: signer.authorityRef,
    issuerRef: signer.issuerRef,
    keyId: signer.keyId,
    algorithm: "Ed25519" as const,
    reason: "active_until_elapsed" as const,
  };
  assertScheduleDisableUnsigned(unsigned);
  const receipt = signedReceipt(signer, "qm.schedule-disable.v1", structuredClone(unsigned));
  return parseScheduleDisableReceipt(Buffer.from(canonicalJson(receipt), "utf8"), signer.publicKey);
}

export function canonicalTimestamp(at: number): string {
  if (!Number.isSafeInteger(at) || at < 0) throw new TypeError("timestamp must be a non-negative safe integer");
  return new Date(at).toISOString();
}

function parseCanonicalBytes(bytes: Uint8Array): unknown {
  if (!utilTypes.isUint8Array(bytes)) {
    throw new TypeError("receipt must be UTF-8 bytes");
  }
  const byteLength = TYPED_ARRAY_BYTE_LENGTH.call(bytes) as number;
  if (byteLength === 0 || byteLength > 16 * 1024) throw new TypeError("receipt byte length is invalid");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TypeError("receipt is not valid UTF-8");
  }
  if (text.startsWith("\uFEFF")) throw new TypeError("receipt must not contain a byte-order mark");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("receipt is not valid JSON");
  }
  if (canonicalJson(value) !== text) throw new TypeError("receipt is not exact canonical JSON");
  return value;
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${field} is invalid`);
  }
}

function assertPositiveRevision(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${field} is invalid`);
}

function assertPublicKey(publicKey: { kty: string; crv: string; x: string }): void {
  if (!publicKey || typeof publicKey !== "object" || Array.isArray(publicKey)) {
    throw new TypeError("schedule receipt public key is invalid");
  }
  assertExactKeys(publicKey, ["kty", "crv", "x"], "schedule receipt public key");
  if (
    publicKey.kty !== "OKP" ||
    publicKey.crv !== "Ed25519" ||
    typeof publicKey.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(publicKey.x) ||
    Buffer.from(publicKey.x, "base64url").toString("base64url") !== publicKey.x
  ) {
    throw new TypeError("schedule receipt public key is invalid");
  }
}

function verifyReceiptSignature(
  receipt: { receiptSha256: string; signature: string },
  unsigned: object,
  domain: string,
  publicKey: { kty: string; crv: string; x: string },
): void {
  assertDigest(receipt.receiptSha256, "receiptSha256");
  if (
    typeof receipt.signature !== "string" ||
    !SIGNATURE.test(receipt.signature) ||
    Buffer.from(receipt.signature, "base64url").toString("base64url") !== receipt.signature
  ) {
    throw new TypeError("signature is invalid");
  }
  if (sha256Canonical(unsigned) !== receipt.receiptSha256) throw new TypeError("receiptSha256 is invalid");
  assertPublicKey(publicKey);
  if (
    !verify(
      null,
      Buffer.from(`${domain}\n${receipt.receiptSha256}`, "utf8"),
      { key: publicKey, format: "jwk" },
      Buffer.from(receipt.signature, "base64url"),
    )
  ) {
    throw new TypeError("schedule receipt signature is invalid");
  }
}

function assertScheduleFireUnsigned(receipt: Omit<QmScheduleFireReceipt, "receiptSha256" | "signature">): void {
  if (
    receipt.contractType !== "qm-schedule-fire-receipt" ||
    receipt.contractVersion !== 1 ||
    receipt.digestRevision !== "QmScheduleFireReceipt.sha256.v1" ||
    receipt.signatureDomain !== "qm.schedule-fire.v1" ||
    receipt.algorithm !== "Ed25519" ||
    receipt.scheduleState !== "active" ||
    receipt.fireMode !== "scheduled"
  ) {
    throw new TypeError("schedule-fire receipt constants are invalid");
  }
  for (const [field, identifier] of [
    ["authorityRef", receipt.authorityRef],
    ["issuerRef", receipt.issuerRef],
    ["keyId", receipt.keyId],
    ["profileRef", receipt.profileRef],
    ["scheduleRef", receipt.scheduleRef],
    ["qmCronId", receipt.qmCronId],
    ["fireKey", receipt.fireKey],
    ["runId", receipt.runId],
    ["sessionId", receipt.sessionId],
    ["threadRef", receipt.threadRef],
  ] as const) {
    assertIdentifier(identifier, field);
  }
  for (const [field, digest] of [
    ["profileSha256", receipt.profileSha256],
    ["scheduleDefinitionSha256", receipt.scheduleDefinitionSha256],
    ["cronRevisionSha256", receipt.cronRevisionSha256],
    ["runRequestTemplateSha256", receipt.runRequestTemplateSha256],
    ["runRequestSha256", receipt.runRequestSha256],
  ] as const) {
    assertDigest(digest, field);
  }
  assertPositiveRevision(receipt.cronStateRevision, "cronStateRevision");
  for (const [field, timestamp] of [
    ["scheduledAt", receipt.scheduledAt],
    ["firedAt", receipt.firedAt],
    ["issuedAt", receipt.issuedAt],
    ["expiresAt", receipt.expiresAt],
  ] as const) {
    assertTimestamp(timestamp, field);
  }
  if (!(
    receipt.scheduledAt <= receipt.firedAt &&
    receipt.firedAt <= receipt.issuedAt &&
    receipt.issuedAt < receipt.expiresAt
  )) {
    throw new TypeError("schedule-fire receipt chronology is invalid");
  }
  if (
    !receipt.localOccurrence ||
    typeof receipt.localOccurrence !== "object" ||
    Array.isArray(receipt.localOccurrence)
  ) {
    throw new TypeError("localOccurrence is invalid");
  }
  assertExactKeys(receipt.localOccurrence, ["localDate", "localTime", "timeZone", "utcOffset"], "localOccurrence");
  if (
    !validDate(receipt.localOccurrence.localDate) ||
    typeof receipt.localOccurrence.localTime !== "string" ||
    !LOCAL_TIME.test(receipt.localOccurrence.localTime) ||
    typeof receipt.localOccurrence.timeZone !== "string" ||
    receipt.localOccurrence.timeZone.length === 0 ||
    typeof receipt.localOccurrence.utcOffset !== "string" ||
    !UTC_OFFSET.test(receipt.localOccurrence.utcOffset)
  ) {
    throw new TypeError("localOccurrence is invalid");
  }
}

function assertScheduleDisableUnsigned(receipt: Omit<QmScheduleDisableReceipt, "receiptSha256" | "signature">): void {
  if (
    receipt.contractType !== "qm-schedule-disable-receipt" ||
    receipt.contractVersion !== 1 ||
    receipt.digestRevision !== "QmScheduleDisableReceipt.sha256.v1" ||
    receipt.signatureDomain !== "qm.schedule-disable.v1" ||
    receipt.algorithm !== "Ed25519" ||
    receipt.reason !== "active_until_elapsed"
  ) {
    throw new TypeError("schedule-disable receipt constants are invalid");
  }
  for (const [field, identifier] of [
    ["authorityRef", receipt.authorityRef],
    ["issuerRef", receipt.issuerRef],
    ["keyId", receipt.keyId],
    ["profileRef", receipt.profileRef],
    ["scheduleRef", receipt.scheduleRef],
    ["qmCronId", receipt.qmCronId],
  ] as const) {
    assertIdentifier(identifier, field);
  }
  for (const [field, digest] of [
    ["profileSha256", receipt.profileSha256],
    ["scheduleDefinitionSha256", receipt.scheduleDefinitionSha256],
    ["cronRevisionSha256", receipt.cronRevisionSha256],
  ] as const) {
    assertDigest(digest, field);
  }
  assertTimestamp(receipt.firstRejectedScheduledAt, "firstRejectedScheduledAt");
  assertTimestamp(receipt.disabledAt, "disabledAt");
  if (receipt.lastEligibleScheduledAt !== null) {
    assertTimestamp(receipt.lastEligibleScheduledAt, "lastEligibleScheduledAt");
    if (receipt.lastEligibleScheduledAt >= receipt.firstRejectedScheduledAt) {
      throw new TypeError("schedule-disable receipt chronology is invalid");
    }
  }
  assertPositiveRevision(receipt.priorStateRevision, "priorStateRevision");
  assertPositiveRevision(receipt.resultingStateRevision, "resultingStateRevision");
  if (
    receipt.firstRejectedScheduledAt > receipt.disabledAt ||
    receipt.resultingStateRevision !== receipt.priorStateRevision + 1
  ) {
    throw new TypeError("schedule-disable receipt transition is invalid");
  }
}

const FIRE_KEYS = [
  "contractType",
  "contractVersion",
  "digestRevision",
  "signatureDomain",
  "authorityRef",
  "issuerRef",
  "keyId",
  "algorithm",
  "profileRef",
  "profileSha256",
  "scheduleRef",
  "qmCronId",
  "scheduleDefinitionSha256",
  "cronRevisionSha256",
  "cronStateRevision",
  "runRequestTemplateSha256",
  "scheduleState",
  "fireMode",
  "fireKey",
  "scheduledAt",
  "firedAt",
  "issuedAt",
  "expiresAt",
  "localOccurrence",
  "runId",
  "sessionId",
  "threadRef",
  "runRequestSha256",
  "receiptSha256",
  "signature",
] as const;

export function parseScheduleFireReceipt(
  bytes: Uint8Array,
  publicKey: { kty: string; crv: string; x: string },
): QmScheduleFireReceipt {
  const value = parseCanonicalBytes(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("schedule-fire receipt is invalid");
  assertExactKeys(value, FIRE_KEYS, "schedule-fire receipt");
  const receipt = value as QmScheduleFireReceipt;
  const { receiptSha256, signature, ...unsigned } = receipt;
  assertScheduleFireUnsigned(unsigned);
  verifyReceiptSignature({ receiptSha256, signature }, unsigned, "qm.schedule-fire.v1", publicKey);
  return receipt;
}

const DISABLE_KEYS = [
  "contractType",
  "contractVersion",
  "digestRevision",
  "signatureDomain",
  "authorityRef",
  "issuerRef",
  "keyId",
  "algorithm",
  "profileRef",
  "profileSha256",
  "scheduleRef",
  "qmCronId",
  "scheduleDefinitionSha256",
  "cronRevisionSha256",
  "reason",
  "lastEligibleScheduledAt",
  "firstRejectedScheduledAt",
  "disabledAt",
  "priorStateRevision",
  "resultingStateRevision",
  "receiptSha256",
  "signature",
] as const;

export function parseScheduleDisableReceipt(
  bytes: Uint8Array,
  publicKey: { kty: string; crv: string; x: string },
): QmScheduleDisableReceipt {
  const value = parseCanonicalBytes(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("schedule-disable receipt is invalid");
  assertExactKeys(value, DISABLE_KEYS, "schedule-disable receipt");
  const receipt = value as QmScheduleDisableReceipt;
  const { receiptSha256, signature, ...unsigned } = receipt;
  assertScheduleDisableUnsigned(unsigned);
  verifyReceiptSignature({ receiptSha256, signature }, unsigned, "qm.schedule-disable.v1", publicKey);
  return receipt;
}
