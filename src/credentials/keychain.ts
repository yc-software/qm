import { validateHeaderName, validateHeaderValue } from "node:http";
import { HOP_BY_HOP } from "../util/http-proxy.ts";
import { scopeId as toScopeId, type Destination, type ScopeId } from "../types.ts";
import { personKey, samePerson } from "../directory/person.ts";
import { hashId } from "../util/crypto.ts";
import { shq } from "../util/shell.ts";
import { homeRelativePath } from "./paths.ts";
import { connectorTokenNote } from "./connector-token.ts";

export const COMPOSIO_ENV_KEY = "COMPOSIO_API_KEY";

export function isBackendCredential(c: { envKey?: string; fields?: ReadonlyArray<{ envKey: string }> }): boolean {
  return c.envKey === COMPOSIO_ENV_KEY || c.fields?.some((f) => f.envKey === COMPOSIO_ENV_KEY) === true;
}

export function isComposioHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return normalized === "composio.dev" || normalized.endsWith(".composio.dev");
}

export type CredentialKind = "env" | "file" | "broker";

export interface CredentialInjection {
  header?: string;
  scheme?: string;
  actor?: boolean;
  headers?: Record<string, string>;
}

const DEFAULT_AUTH_HEADER = "Authorization";
const RESERVED_FIXED_HEADERS = new Set([
  ...HOP_BY_HOP,
  "authorization",
  "content-encoding",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "x-qm-actor",
]);

const headerError = (validate: () => void): boolean => {
  try {
    validate();
    return false;
  } catch {
    return true;
  }
};

function fixedHeadersError(headers: unknown, authHeader: string): string | undefined {
  if (headers === undefined) return undefined;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "injection.headers must be an object";
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (headerError(() => validateHeaderName(name)))
      return `injection.headers: "${name}" is not a valid HTTP header name`;
    if (RESERVED_FIXED_HEADERS.has(lower) || lower === authHeader) return `injection.headers cannot set ${lower}`;
    if (seen.has(lower)) return `injection.headers lists ${lower} more than once`;
    seen.add(lower);
    if (typeof value !== "string" || !value || headerError(() => validateHeaderValue(name, value)))
      return `injection.headers.${name} must be a non-empty valid HTTP header value`;
  }
  return undefined;
}

export function credentialRequestHeaders(rec: {
  injection?: CredentialInjection;
  secret: string;
}): Record<string, string> {
  const header = rec.injection?.header || DEFAULT_AUTH_HEADER;
  const rawScheme = rec.injection?.scheme ?? "Bearer ";
  const scheme = rawScheme && !/\s$/.test(rawScheme) ? `${rawScheme} ` : rawScheme;
  return { ...rec.injection?.headers, [header]: `${scheme}${rec.secret}` };
}

export function credentialInjectionError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "injection must be an object";
  const injection = value as CredentialInjection;
  if (injection.actor !== undefined && typeof injection.actor !== "boolean") return "injection.actor must be boolean";
  if (
    injection.header !== undefined &&
    (typeof injection.header !== "string" || headerError(() => validateHeaderName(injection.header!)))
  )
    return "authentication header must be a valid HTTP header name";
  if (injection.header?.toLowerCase() === "x-qm-actor") return "x-qm-actor is reserved for broker actor attestation";
  if (injection.scheme !== undefined && (typeof injection.scheme !== "string" || /[\r\n]/.test(injection.scheme)))
    return "authentication value prefix must be a single line";
  return fixedHeadersError(injection.headers, (injection.header || DEFAULT_AUTH_HEADER).toLowerCase());
}

interface BrokerDelivery {
  name: string;
  delivery?: "broker" | "env";
  envKey?: string;
  injection?: CredentialInjection;
  allowedMethods?: string[];
  allowedPathPrefixes?: string[];
  deployments?: boolean;
  enabled: boolean;
  updatedBy?: string;
}

interface CredentialRefresh {
  refreshTokenEnc?: string;
  idTokenEnc?: string;
  accountId?: string;
  accountType?: string;
  clientRef?: string;
  grantedScopes?: string[];
  refreshFailedAt?: number;
  refreshError?: string;
  orgId?: string;
}

export interface CredentialFile {
  path: string;
  contentBase64: string;
  mode?: number;
}

export function restoredFileMode(mode?: number): number {
  return ((mode ?? 0o600) & 0o700) | 0o600;
}

interface CredentialFieldMeta {
  envKey: string;
  secret: boolean;
}

export interface CredentialFieldInput {
  envKey: string;
  value: string;
  secret?: boolean;
}

export interface KeychainCredential {
  id: string;
  ownerId: string;
  orgId?: string;
  service: string;
  kind: CredentialKind;
  envKey?: string;
  targets?: string[];
  host?: string;
  accountLabel?: string;
  fields?: CredentialFieldMeta[];
  broker?: BrokerDelivery;
  refresh?: CredentialRefresh;
  managed?: "connector";
  secretEnc: string;
  fingerprint: string;
  origin?: string;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type KeychainCredentialMeta = Omit<KeychainCredential, "secretEnc"> & { credentialHandle?: string };

export type GrantMode = "once" | "standing";

export interface KeychainGrant {
  id: string;
  credentialId: string;
  ownerId: string;
  orgId?: string;
  audienceScopeId: ScopeId;
  mode: GrantMode;
  purpose: string;
  status: "active" | "revoked" | "used";
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  usedAt?: number;
  usedBy?: string;
  askId?: string;
}

type AskStatus = "pending" | "approved" | "declined" | "expired";

export interface KeychainAsk {
  id: string;
  credentialId: string;
  ownerId: string;
  requesterId: string;
  orgId?: string;
  requesterScopeId: ScopeId;
  requesterDestination?: Destination;
  requesterThreadRef?: string;
  requesterSeq?: number;
  requesterMessageTs?: string;
  purpose: string;
  requestedMode?: GrantMode;
  status: AskStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  grantId?: string;
  note?: string;
  notifiedAt?: number;
}

export const ASK_TTL_MS = 24 * 60 * 60_000;
export const ASK_PRUNE_AFTER_MS = 14 * 24 * 60 * 60_000;

export interface ServiceCredentialInput {
  slug: string;
  name: string;
  secret?: string;
  delivery?: "broker" | "env";
  envKey?: string;
  host: string;
  injection?: CredentialInjection;
  allowedMethods?: string[];
  allowedPathPrefixes?: string[];
  deployments?: boolean;
  enabled?: boolean;
  updatedBy?: string;
}

export interface PublicServiceCredential {
  slug: string;
  name: string;
  delivery: "broker" | "env";
  envKey?: string;
  host: string;
  injection?: CredentialInjection;
  allowedMethods?: string[];
  allowedPathPrefixes?: string[];
  deployments: boolean;
  enabled: boolean;
  hasSecret: boolean;
  maxRequestsPerDay?: number;
  source?: "deployment";
  updatedBy?: string;
  updatedAt: number;
}

export interface DecryptedServiceCredential {
  slug: string;
  name: string;
  secret: string;
  delivery: "broker" | "env";
  envKey?: string;
  host: string;
  injection?: CredentialInjection;
  allowedMethods?: string[];
  allowedPathPrefixes?: string[];
  deployments: boolean;
  enabled: boolean;
  maxRequestsPerDay?: number;
  source?: "deployment";
}

export function isValidCredentialSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug);
}

export function isValidServiceCredentialEnvKey(envKey: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(envKey) && !envKey.startsWith("AGENT_");
}

export function isValidBrokerHost(host: string): boolean {
  return Boolean(host) && host === host.toLowerCase() && !/[/:\s]/.test(host);
}

export function isValidBrokerMethod(method: string): boolean {
  return /^[A-Z]+$/.test(method);
}

export function isValidBrokerPathPrefix(path: string): boolean {
  return path.startsWith("/") && !/[\r\n]/.test(path);
}

export interface ServiceCredentialReader {
  getServiceCredentialSecret(orgScopeId: ScopeId, slug: string): Promise<DecryptedServiceCredential | null>;
}

export interface ServiceCredentialStore extends ServiceCredentialReader {
  setServiceCredential(orgScopeId: ScopeId, input: ServiceCredentialInput): Promise<void>;
  setServiceCredentialIfAbsent(orgScopeId: ScopeId, input: ServiceCredentialInput): Promise<number | null>;
  setServiceCredentialIfCurrent(
    orgScopeId: ScopeId,
    input: ServiceCredentialInput,
    expectedUpdatedAt: number,
  ): Promise<number | null>;
  listServiceCredentials(orgScopeId: ScopeId): Promise<PublicServiceCredential[]>;
  deleteServiceCredential(orgScopeId: ScopeId, slug: string): Promise<void>;
  deleteServiceCredentialIfCurrent(orgScopeId: ScopeId, slug: string, expectedUpdatedAt: number): Promise<boolean>;
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  grantedScopes?: string[];
  clientRef?: string;
  accountType?: string;
  orgId?: string;
  /** OIDC id token, for providers whose API needs it alongside the access token (e.g. Codex). */
  idToken?: string;
  /** Provider-side account identifier carried with the token (e.g. ChatGPT account id). */
  accountId?: string;
}

/** Derived, sandbox-safe view of a connector token: never carries the refresh token. */
export interface DerivedOAuthAuth {
  accessToken: string;
  idToken?: string;
  accountId?: string;
  expiresAt?: number;
}

export interface OAuthTokenStatus {
  connected: boolean;
  expiresAt?: number;
  hasRefreshToken?: boolean;
  needsReconnect?: boolean;
  refreshFailedAt?: number;
  refreshError?: string;
  accountType?: string;
  grantedScopes?: string[];
}

export type OAuthRefresh = (
  host: string,
  token: OAuthToken,
  ctx?: { accountType?: string; clientRef?: string },
) => Promise<OAuthToken>;

interface ConnectorMeta {
  credentialId: string;
  ownerId: string;
  host: string;
  accountType?: string;
  expiresAt?: number;
  connected: boolean;
  needsReconnect?: boolean;
}

export interface ConnectorTokenStore {
  listConnectorsByOwners?(ownerIds: string[]): Promise<Map<string, ConnectorMeta[]>>;
  setConnectorToken(host: string, principalId: string, token: OAuthToken, accountType?: string): Promise<void>;
  deleteConnectorToken(host: string, principalId: string, accountType?: string): Promise<void>;
  connectorTokenStatus(host: string, principalId: string, accountType?: string): Promise<OAuthTokenStatus>;
  connectorAccessToken(host: string, principalId: string, accountType?: string): Promise<string | null>;
  /**
   * Fresh derived material for the connector token (access + id token +
   * account id), refreshing single-flight if stale. The refresh token never
   * leaves the keychain record.
   */
  connectorDerivedAuth(host: string, principalId: string, accountType?: string): Promise<DerivedOAuthAuth | null>;
}

export interface SaveCredentialInput {
  ownerId: string;
  service: string;
  secret?: string;
  envKey?: string;
  fields?: CredentialFieldInput[];
  target?: string;
  files?: CredentialFile[];
  host?: string;
  accountLabel?: string;
  origin?: string;
  expiresAt?: number;
}

export interface CreateGrantInput {
  credentialId: string;
  ownerId: string;
  audienceScopeId: ScopeId;
  mode: GrantMode;
  purpose: string;
  expiresAt?: number;
  askId?: string;
}

interface CreateAskInput {
  triggered?: boolean;
  credentialId: string;
  requesterId: string;
  requesterScopeId: ScopeId;
  requesterDestination?: Destination;
  requesterThreadRef?: string;
  requesterSeq?: number;
  requesterMessageTs?: string;
  purpose: string;
  requestedMode?: GrantMode;
  expiresAt?: number;
}

interface ApproveAskInput {
  askId: string;
  ownerId: string;
  mode: GrantMode;
  purpose: string;
  expiresAt?: number;
}

interface AskListFilter {
  requesterId?: string;
  ownerId?: string;
  requesterScopeId?: ScopeId;
}

export interface MaterializedEnvCred {
  credentialId: string;
  ownerId: string;
  service: string;
  env: Array<{ key: string; value: string; secret?: boolean }>;
  grantId?: string;
  purpose?: string;
}

export interface MaterializedFileCred {
  credentialId: string;
  ownerId: string;
  service: string;
  files: CredentialFile[];
  origin?: string;
  grantId?: string;
  purpose?: string;
}

interface MaterializedConnectorCred {
  credentialId: string;
  ownerId: string;
  service: string;
  host: string;
  accountType?: string;
  grantId?: string;
  purpose?: string;
}

export type MaterializedCred =
  | ({ kind: "env" } & MaterializedEnvCred)
  | ({ kind: "file" } & MaterializedFileCred)
  | ({ kind: "connector" } & MaterializedConnectorCred);

export class KeychainError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "KeychainError";
    this.status = status;
  }
}

interface GrantListFilter {
  ownerId?: string;
  audienceScopeId?: ScopeId;
}

export interface Keychain extends ServiceCredentialStore, ConnectorTokenStore {
  save(input: SaveCredentialInput): Promise<KeychainCredentialMeta>;
  updateFiles(materialized: Extract<MaterializedCred, { kind: "file" }>, files: CredentialFile[]): Promise<void>;
  writebackBaseline(
    source: FileCredentialSource,
    fingerprint: string,
  ): Promise<Extract<MaterializedCred, { kind: "file" }>>;
  listAllMetadata(): Promise<KeychainCredentialMeta[]>;
  listByOwner(ownerId: string): Promise<KeychainCredentialMeta[]>;
  listByOwners(ownerIds: string[]): Promise<Map<string, KeychainCredentialMeta[]>>;
  listConnectorsByOwners(ownerIds: string[]): Promise<Map<string, ConnectorMeta[]>>;
  getCredential(id: string): Promise<KeychainCredentialMeta | null>;
  /** Decrypt an env credential the caller OWNS — no grant machinery, never someone else's. */
  readOwnSecret(ownerId: string, credentialId: string): Promise<string | null>;
  remove(ownerId: string, id: string): Promise<boolean>;

  createGrant(input: CreateGrantInput): Promise<KeychainGrant>;
  getGrant(id: string): Promise<KeychainGrant | null>;
  listGrants(filter: GrantListFilter): Promise<KeychainGrant[]>;
  revokeGrant(ownerId: string, grantId: string): Promise<boolean>;
  grantsForScope(scopeId: ScopeId): Promise<Array<{ grant: KeychainGrant; credential: KeychainCredentialMeta }>>;

  createAsk(input: CreateAskInput): Promise<{ ask: KeychainAsk; existing: boolean }>;
  getAsk(id: string): Promise<KeychainAsk | null>;
  listAsks(filter: AskListFilter): Promise<KeychainAsk[]>;
  approveAsk(input: ApproveAskInput): Promise<{ ask: KeychainAsk; grant: KeychainGrant }>;
  declineAsk(input: { askId: string; ownerId: string; note?: string }): Promise<KeychainAsk>;
  unnotifiedResolvedAsks(now: number): Promise<KeychainAsk[]>;
  markAskNotified(id: string, status: KeychainAsk["status"]): Promise<void>;

  composioKey(ownerId: string, credentialId: string): Promise<string | null>;
  prepareMaterialize(
    grantId: string,
    scopeId: ScopeId,
    usedBy: string,
  ): Promise<{
    materialized: MaterializedCred;
    singleUse: boolean;
    commit(): Promise<void>;
  }>;
  materializeOwnById(ownerId: string, credentialId: string, scopeId: ScopeId): Promise<MaterializedCred>;
  materializeOwn(ownerId: string): Promise<MaterializedEnvCred[]>;
  materializeOwnFiles(ownerId: string): Promise<MaterializedFileCred[]>;
}

export function fingerprintOf(secret: string): string {
  return hashId([secret]);
}

export function credentialHandle(credential: Pick<KeychainCredential, "id" | "service">): string {
  return `${encodeURIComponent(credential.service)}:${credential.id}`;
}

export interface FileCredentialSource {
  credentialId: string;
  ownerId: string;
  service: string;
  grantId?: string;
}

export function credentialFilesFingerprint(files: CredentialFile[]): string {
  return fileCredentialFingerprint(
    files
      .map((file) => ({ ...file, mode: restoredFileMode(file.mode) }))
      .sort((a, b) => homeRelativePath(a.path).localeCompare(homeRelativePath(b.path))),
  );
}

function fileCredentialFingerprint(files: CredentialFile[]): string {
  return fingerprintOf(JSON.stringify(files.map((f) => ({ ...f, path: homeRelativePath(f.path) }))));
}

export function fileCredentialEnvironment(files: CredentialFile[], home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home };
  const pointers: Array<[RegExp, string, boolean?]> = [
    [/^\.aws\/credentials$/, "AWS_SHARED_CREDENTIALS_FILE"],
    [/^\.aws\/config$/, "AWS_CONFIG_FILE"],
    [/^\.kube\/config$/, "KUBECONFIG"],
    [/^\.config\/gh\/hosts\.yml$/, "GH_CONFIG_DIR", true],
    [/^(?:\.config\/(?:glab-cli|glab)|Library\/Application Support\/glab-cli)\/config\.yml$/, "GLAB_CONFIG_DIR", true],
    [/^\.docker\/config\.json$/, "DOCKER_CONFIG", true],
    [/^\.npmrc$/, "NPM_CONFIG_USERCONFIG"],
    [/^\.netrc$/, "NETRC"],
  ];
  for (const file of files) {
    const rel = homeRelativePath(file.path);
    for (const [pattern, key, directory] of pointers) {
      if (pattern.test(rel) && !(key in env)) env[key] = `${home}/${directory ? rel.replace(/\/[^/]*$/, "") : rel}`;
    }
    if (/^\.ssh\/[^/]*(id_|key)[^/]*$/.test(rel) && !env.GIT_SSH_COMMAND)
      env.GIT_SSH_COMMAND = `ssh -i ${shq(`${home}/${rel}`)} -o IdentitiesOnly=yes`;
  }
  return env;
}

function hoursLeft(expiresAt: number, now: number): number {
  return Math.max(1, Math.round((expiresAt - now) / 3_600_000));
}

export function renderAskNotice(
  input: {
    ask: KeychainAsk;
    credential: KeychainCredentialMeta;
    requesterName?: string;
    channelName?: string;
    scopeName?: string;
    taskTitle?: string;
  },
  now: number = Date.now(),
): string {
  const { ask, credential } = input;
  const who = input.requesterName ? `${input.requesterName} (${ask.requesterId})` : ask.requesterId;
  let where: string;
  if (input.channelName) where = `**#${input.channelName.replace(/^#/, "")}**`;
  else if (input.scopeName) where = `**${input.scopeName}**`;
  else if (ask.requesterScopeId.startsWith("group:")) where = "a group conversation";
  else if (ask.requesterScopeId.startsWith("channel:")) where = "a Slack channel";
  else if (ask.requesterScopeId.startsWith("personal:")) where = "their own conversation";
  else where = "a shared conversation";
  const task = input.taskTitle ? `Scheduled task "${input.taskTitle}": ` : "";
  const account = credential.accountLabel ? ` (${credential.accountLabel})` : "";
  const self = ask.requesterScopeId.startsWith("personal:") && samePerson(ask.ownerId, ask.requesterId);
  return (
    `${task}${self ? "A task in your personal conversation" : `${who} in ${where}`} wants to use your **${credential.service}** credential${account}. ` +
    `Approve or deny on the card (expires in ${hoursLeft(ask.expiresAt, now)}h).`
  );
}

export interface KeychainManifestInput {
  scopeId: ScopeId;
  conversationKind: "dm" | "channel" | "group";
  openSpeakerKeychain?: boolean;
  actorId: string;
  members: Array<{ id: string; displayName?: string }>;
  entriesByOwner: Map<string, KeychainCredentialMeta[]>;
  connectorsByOwner?: Map<string, ConnectorMeta[]>;
  scopeGrants: Array<{ grant: KeychainGrant; credential: KeychainCredentialMeta }>;
  execution?: Array<{
    handle: string;
    ownerId: string;
    credentialId?: string;
    description: string;
  }>;
  detectedByOwner?: Map<string, string[]>;
  scopeAsks?: KeychainAsk[];
}

function expiryNote(c: KeychainCredentialMeta, now: number, own: boolean): string {
  if (c.kind === "file" || typeof c.expiresAt !== "number") return "";
  if (c.expiresAt < now) {
    return own
      ? ", EXPIRED — they must re-auth before it can be used"
      : ", EXPIRED — ask the owner to re-auth before requesting a grant";
  }
  return `, expires at ${new Date(c.expiresAt).toISOString()}`;
}

function credentialDescription(c: KeychainCredentialMeta, now: number, own: boolean): string {
  if (c.managed === "connector") return connectorDescription(connectorMeta(c, now));
  if (isBackendCredential(c))
    return "Composio backend access — use the composio skill; cannot be loaded into a computer";
  const slot =
    c.kind === "env"
      ? (c.fields?.map((f) => f.envKey) ?? [c.envKey])
          .filter(Boolean)
          .sort()
          .map((key) => `\`${key}\``)
          .join(" + ")
      : `files ${(c.targets ?? []).toSorted().join(", ")}`;
  return `${c.service} (${slot}${c.accountLabel ? `, account ${c.accountLabel}` : ""}${expiryNote(c, now, own)})`;
}

export const oauthExpired = (rec: KeychainCredentialMeta, t: number, oauthSkew: number) =>
  rec.expiresAt !== undefined && t >= rec.expiresAt - oauthSkew;

export function connectorMeta(rec: KeychainCredentialMeta, t: number, oauthSkew = 60_000): ConnectorMeta {
  const hasRefresh = !!rec.refresh?.refreshTokenEnc;
  const refreshFailed = typeof rec.refresh?.refreshFailedAt === "number";
  const tokenExpired = oauthExpired(rec, t, oauthSkew);
  return {
    credentialId: rec.id,
    ownerId: rec.ownerId,
    host: rec.host ?? rec.service,
    ...(rec.refresh?.accountType ? { accountType: rec.refresh.accountType } : {}),
    ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
    connected: true,
    ...(tokenExpired && (!hasRefresh || refreshFailed) ? { needsReconnect: true } : {}),
  };
}

function connectorDescription(cm: ConnectorMeta): string {
  return `connected app ${cm.host}, account ${cm.accountType ?? "default"}${
    cm.needsReconnect ? ", NEEDS RECONNECT — owner must reconnect the app before use" : ""
  }${typeof cm.expiresAt === "number" ? `, token expires at ${new Date(cm.expiresAt).toISOString()}` : ""}; ${connectorTokenNote(cm.host)}`;
}

export const MAX_CREDENTIAL_FILES = 500;
export const MAX_CREDENTIAL_BYTES = 8 * 1024 * 1024;

export function renderKeychainManifest(input: KeychainManifestInput, now: number = Date.now()): string {
  const groups = new Map<string, Map<string, { text: string; note: string; purpose?: string }>>();
  const put = (ownerId: string, id: string, text: string, note = "", purpose?: string): void => {
    const owner = personKey(ownerId);
    let rows = groups.get(owner);
    if (!rows) groups.set(owner, (rows = new Map()));
    rows.set(id, { text, note, ...(purpose ? { purpose } : {}) });
  };
  const ownPersonal = input.scopeId === toScopeId("personal", input.actorId);
  const openSpeaker = input.openSpeakerKeychain === true && input.conversationKind !== "dm";
  const isOwn = (ownerId: string): boolean => (ownPersonal || openSpeaker) && samePerson(ownerId, input.actorId);
  const grants = new Map(input.scopeGrants.map(({ grant, credential }) => [credential.id, grant]));
  const execution = input.execution ?? [];
  const handle = (entry: (typeof execution)[number]): string => `\`${entry.handle}\``;
  const access = (ownerId: string, id: string): [string, string?] => {
    const grant = grants.get(id);
    if (grant)
      return [
        `${grant.mode === "standing" ? "STANDING" : "one-time"} grant \`${grant.id}\`${
          grant.expiresAt === undefined ? "" : `, expires at ${new Date(grant.expiresAt).toISOString()}`
        }`,
        grant.purpose,
      ];
    if (!isOwn(ownerId)) return ["no grant for this conversation"];
    return [openSpeaker ? "own; Open live turn only" : "own; no grant needed (including background turns)"];
  };
  const handles = (credentialId: string): string =>
    execution
      .filter((entry) => entry.credentialId === credentialId)
      .map(handle)
      .sort()
      .join(", ") || `credential id \`${credentialId}\``;
  const entries = new Map(input.scopeGrants.map(({ credential }) => [credential.id, credential]));
  for (const member of input.members)
    for (const credential of input.entriesByOwner.get(member.id) ?? []) entries.set(credential.id, credential);
  for (const credential of entries.values())
    put(
      credential.ownerId,
      credential.id,
      `- ${handles(credential.id)} — ${credentialDescription(credential, now, isOwn(credential.ownerId))}`,
      ...access(credential.ownerId, credential.id),
    );
  for (const member of input.members) {
    for (const connector of input.connectorsByOwner?.get(member.id) ?? [])
      put(
        member.id,
        connector.credentialId,
        `- ${handles(connector.credentialId)} — ${connectorDescription(connector)}`,
        ...access(member.id, connector.credentialId),
      );
    const registered = new Set((input.entriesByOwner.get(member.id) ?? []).map((c) => c.service.toLowerCase()));
    for (const service of input.detectedByOwner?.get(member.id) ?? [])
      if (!registered.has(service.toLowerCase()))
        put(member.id, `detected:${service}`, `- ${service} — detected on their computer, NOT registered or grantable`);
  }
  for (const entry of execution) {
    if (entry.credentialId && groups.get(personKey(entry.ownerId))?.has(entry.credentialId)) continue;
    put(entry.ownerId, entry.handle, `- ${handle(entry)} — ${entry.description}`);
  }
  const lines = [
    "## Credentials",
    "Execution handles are shown in backticks; select them in execute.credentials. Credential IDs identify entries for access requests, not execution handles.",
  ];
  for (const [ownerId, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const member = input.members.find((member) => personKey(member.id) === ownerId);
    const rows = [...group.values()].sort((a, b) => a.text.localeCompare(b.text));
    const notes = new Set(rows.map((row) => row.note));
    const shared = notes.size === 1 && rows.every((row) => !row.purpose) ? rows[0]!.note : "";
    const purposes = new Set<string>();
    lines.push(
      "",
      `### ${member?.displayName ? `${member.displayName} (${ownerId})` : ownerId}${shared ? ` — ${shared}` : ""}`,
      ...rows.map((row) => {
        const said = row.purpose !== undefined && purposes.has(row.purpose);
        if (row.purpose) purposes.add(row.purpose);
        const purpose = row.purpose ? ` (purpose: ${said ? "as above" : `"${row.purpose}"`})` : "";
        return `${row.text}${row.note && !shared ? `; ${row.note}` : ""}${purpose}`;
      }),
    );
  }
  if (!groups.size) lines.push("", "No credentials available.");
  const asks = (input.scopeAsks ?? []).flatMap((ask) => {
    if (ask.status === "pending") return [`- waiting on ${ask.ownerId}'s approval card`];
    if (ask.resolvedAt !== undefined && now - ask.resolvedAt < 24 * 3_600_000)
      return [`- request to ${ask.ownerId}: ${ask.status}`];
    return [];
  });
  if (asks.length) lines.push("", "Asks sent from this conversation:", ...asks.sort());
  lines.push(
    "",
    "Grants: Use of private credentials outside of a 1:1 DM with that person requires an explicit grant. The exception is the live speaker's own credentials in an Open shared conversation, for their live turn only, not continuing room or background access. Otherwise use the `request-access` skill; consider whether one-time, standing or time-bound access fits the request.",
    "Secret drop: for a credential nobody has saved, mint a one-time link with the `secret-drop` skill; never collect secrets in chat or send people to the keychain page. Keys enter the submitter's private keychain; in a shared channel they are shared for use in that channel alone.",
    "Device code or CLI logins: read the `interactive-login` skill from the first step. It logs in under a temporary home and saves the result. Never log in against this computer's $HOME; only keychain entries are durable and grantable.",
  );
  return lines.join("\n");
}
