import {
  refreshPrivateContext,
  privateSourceAllowed,
  inheritContextSources,
  type PrivateContext,
} from "../sessions/private-context.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { EXTERNAL_APP_SHARING_OFF } from "../feature-flags.ts";
import { notifyAppShared } from "./share-notice.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { EMBED_ANCESTORS_HINT, parseEmbedAncestors } from "./embed-ancestors.ts";
import { appShareScope } from "./email-access.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { Grant, Permission, ScopeId } from "../types.ts";
import { isManageableCreationScope, parseScopeId, scopeId } from "../types.ts";
import type { AclStore } from "../acl/acl-store.ts";
import { deployRef, encodeRef, parseRef } from "../acl/resource-ref.ts";
import { bytes, normalizeRelPath } from "./deploy-fs.ts";
import { samePerson } from "../directory/person.ts";
import { personOrOwningBot } from "../auth/capability-token.ts";
import { CONNECTOR_HOSTS } from "../connectors/oauth.ts";
import { recordAuditInBinding, type AuditEvent, type AuditLog } from "../audit/audit-log.ts";
import {
  appUrlOf,
  currentVersionOf,
  deployCurrentGitRef,
  type DeployStore,
  type PublishedApp,
  type DeployEndpoint,
  type AppDraft,
  type AppVersion,
} from "./deploy-store.ts";
import type { DeployProfile, DeployProvider } from "./deploy-provider.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue } from "../util/async.ts";
import { errMessage, reportFailure, swallow } from "../util/errors.ts";
import { uuidSchema } from "../util/ids.ts";
import { claimThenBind } from "../tenants/claim.ts";
import { assertAppLabelFits } from "../tenants/settings.ts";
import { createLiveEdits, type LiveEditSaved } from "./live-edits.ts";
import { ambientTenant, type Tenant } from "../tenants/context.ts";

export interface DeployFile {
  path: string;
  data: string | Uint8Array;
}

export interface RedeployInput {
  context?: PrivateContext;
  entrypoint: string;
  files: DeployFile[];
  homeFiles?: DeployFile[];
  env?: Record<string, string>;
  stampEnv?: Record<string, string>;
  alwaysOn?: boolean;
  actor?: string;
}

export interface DeployInput extends RedeployInput {
  ownerScopeId: ScopeId;
  createdBy: string;
  createdInScope?: ScopeId;
  name?: string;
}

export type Reach =
  { status: "ok"; id: string; endpoint: DeployEndpoint } | { status: "denied" } | { status: "not_found" };

type PublishedAppWithLiveEdit = PublishedApp & { liveEdit?: LiveEditSaved };

export interface AppSourceReader {
  commit: string;
  source(paths?: string[], commit?: string): Promise<AppSource>;
}

export interface AppSource {
  commit: string;
  tree: Array<{ path: string; sha: string; size: number }>;
  files: Array<{ path: string; data: Uint8Array }>;
}

export interface SourceEdit {
  files: DeployFile[];
  deletedPaths: string[];
}

export interface SourceSaved {
  saved: Array<{ path: string; sha: string }>;
  deleted: string[];
  version: number;
  liveEdit?: LiveEditSaved;
}

export interface DeployOrUpdateInput {
  context?: PrivateContext;
  ownerScopeId: ScopeId;
  createdBy: string;
  botActor?: boolean;
  name?: string;
  entrypoint?: string;
  files?: DeployFile[];
  homeFiles?: DeployFile[];
  env?: Record<string, string>;
  stampEnv?: Record<string, string>;
  renameFrom?: string;
  rollbackTo?: number;
  createdInScope?: ScopeId;
  alwaysOn?: boolean;
  embedAncestors?: string[];
}

export interface AppActor {
  createdBy: string;
  botActor?: boolean;
}

export interface ReachOptions {
  bypassAcl?: boolean;
}

export interface DeployService {
  readonly providerProfile: DeployProfile;
  deploy(input: DeployInput): Promise<PublishedApp>;
  redeploy(id: string, input: RedeployInput): Promise<PublishedAppWithLiveEdit>;
  getApp(idOrName: string): Promise<PublishedApp | null>;
  appUrl?(d: PublishedApp): string | undefined;
  listApps(): Promise<PublishedApp[]>;
  rollbackApp(
    id: string,
    version: number,
    options?: { alwaysOn?: boolean; actor?: string; context?: PrivateContext },
  ): Promise<void>;
  archiveApp(id: string, context?: PrivateContext): Promise<void>;
  restoreApp(id: string, actorId?: string, context?: PrivateContext): Promise<PublishedApp>;
  renameApp(id: string, name: string, context?: PrivateContext): Promise<PublishedApp>;
  setAppDisplayName(id: string, displayName: string, context?: PrivateContext): Promise<PublishedApp>;
  setAppAlwaysOn(id: string, alwaysOn: boolean, context?: PrivateContext): Promise<PublishedApp>;
  setAppEmbedAncestors(id: string, embedAncestors: string[], context?: PrivateContext): Promise<PublishedApp>;
  setAppPublic(
    idOrName: string,
    isPublic: boolean,
    actor: AppActor & { personAtKeyboard: boolean },
  ): Promise<PublishedApp>;
  setAppConnectors(
    idOrName: string,
    connectors: string[],
    actor: { createdBy: string; context?: PrivateContext },
  ): Promise<PublishedApp>;

  maintainApps(): Promise<number>;
  publishDueLiveEdits(): Promise<number>;
  liveEditOf(idOrName: string): Promise<{ draft: AppDraft | null } | null>;
  reachApp(idOrName: string, principalId: string, opts?: ReachOptions): Promise<Reach>;
  appLogs(idOrName: string, opts: { tailLines: number }): Promise<string | null>;
  gitRepoPath(idOrName: string): Promise<string | null>;
  readApp<T>(id: string, read: (app: PublishedApp | null) => Promise<T>): Promise<T>;
  pushGit<T>(
    id: string,
    runReceivePack: () => Promise<{ result: T; ok: boolean }>,
    actor?: string | PrivateContext,
  ): Promise<T>;
  source(idOrName: string, paths?: string[], commit?: string): Promise<AppSource | null>;
  sourceReader(idOrName: string, caller: PrivateContext, actingScopeId?: ScopeId): Promise<AppSourceReader | null>;
  editSource(
    idOrName: string,
    actor: string | PrivateContext,
    edit: (read: (paths: string[]) => Promise<AppSource>) => Promise<SourceEdit>,
  ): Promise<SourceSaved>;
  reapIdleApps(ttlMs: number, now?: number): Promise<number>;
  deployOrUpdate(input: DeployOrUpdateInput): Promise<PublishedAppWithLiveEdit>;
  appGrantees(idOrName: string): Promise<AppGrantee[]>;
  canManageApp(idOrName: string, caller: PrivateContext, actingScopeId?: ScopeId): Promise<boolean>;
  shareApp(
    idOrName: string,
    grantee: ScopeId,
    permission: Permission | null,
    actor: AppActor,
    opts?: { notify?: boolean },
  ): Promise<AppGrantee[]>;
  assertAppOwner(d: PublishedApp, actor: AppActor): Promise<void>;
  grantAppAccess(grant: Grant): Promise<void>;
  assertShareAllowed(
    d: PublishedApp,
    grantee: ScopeId,
    permission: Permission | null,
    grantedBy: string,
  ): Promise<void>;
  transferAppOwner(
    idOrName: string,
    toScope: ScopeId,
    actor: { callerId: string; actingScopeId?: ScopeId },
  ): Promise<PublishedApp>;
}

export interface AppGrantee {
  scope: ScopeId;
  permission: Permission;
}

const PUBLIC_LINKS_UNAVAILABLE =
  "This instance serves apps at /d/<app>/ on its own domain, which always requires sign-in, so a public link would still ask visitors to sign in. Public links need an apps domain: set DEPLOY_APPS_DOMAIN to a domain with a wildcard DNS record routed to the portal, and AWS_DEPLOY_GATE_SECRET.";

export type DeployAccessErrorCode =
  | "not_found"
  | "forbidden"
  | "external_sharing_disabled"
  | "public_links_unavailable"
  | "unknown_connector"
  | "human_consent_required";

export class DeployAccessError extends Error {
  readonly code: DeployAccessErrorCode;
  constructor(code: DeployAccessErrorCode, message: string) {
    super(message);
    this.name = "DeployAccessError";
    this.code = code;
  }
}

export interface DeployServiceDeps {
  sessions?: Pick<SessionStore, "getMany" | "recordContextProvenance">;
  deliveries?: DeliveryStore;
  deployAppsDomain?: string;
  publicLinksAvailable?: boolean;
  publicWebUrl?: string;
  deployStore: DeployStore;
  provider: DeployProvider;
  deployDir: string;
  auditLog: AuditLog;
  acl: AclStore;
  leaderLease: LeaderLease;
  advisoryLock: AdvisoryLock;
  canReadScope?: (principalId: string, scopeId: ScopeId) => Promise<boolean>;
  canWriteScope?: (principalId: string, scopeId: ScopeId) => Promise<boolean>;
  canManageEmail?: (email: string) => Promise<boolean>;
  externalSharingAllowed?: (ownerScopeId: ScopeId) => Promise<boolean>;
  managesArtifactHome?: (homeScopeId: ScopeId, createdBy: string, principalId: string) => Promise<boolean>;
  appEnv?: (publishedApp: PublishedApp) => Promise<Record<string, string>>;
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function assertAppSize(sizes: readonly number[], maxBytes: number | undefined): void {
  if (!maxBytes) return;
  const total = sizes.reduce((sum, n) => sum + n, 0);
  if (total > maxBytes) {
    throw new Error(
      `the app is too large to publish: ${total} bytes, maximum ${maxBytes} bytes — publish fewer or smaller files`,
    );
  }
}

const fileSizes = (files: readonly DeployFile[] | undefined): number[] =>
  (files ?? []).map((f) => (typeof f.data === "string" ? Buffer.byteLength(f.data) : f.data.byteLength));

function validateName(name: string): void {
  if (uuidSchema.safeParse(name).success) throw new Error(`invalid app name (looks like an id): ${name}`);
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid app name "${name}": use 2-40 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen`,
    );
  }
  assertAppLabelFits(name);
}

const DISPLAY_NAME_MAX = 60;
function validateDisplayName(displayName: string): void {
  if (/[\u0000-\u001f\u007f]/.test(displayName)) throw new Error("invalid display name: no control characters");
  if (displayName.length > DISPLAY_NAME_MAX) throw new Error(`display name too long (max ${DISPLAY_NAME_MAX} chars)`);
}

export function appEntrypoint(d: PublishedApp | null): string | undefined {
  return currentVersionOf(d)?.entrypoint || undefined;
}

function requiredEntrypoint(input: string | undefined, d: PublishedApp | null): string {
  const entrypoint = input ?? appEntrypoint(d);
  if (!entrypoint) throw new Error('publish requires an entrypoint, e.g. "node server.js"');
  return entrypoint;
}

export function createDeployService(deps: DeployServiceDeps): DeployService {
  const leaderLease = deps.leaderLease;
  const advisoryLock = deps.advisoryLock;
  const deployQueue = createKeyedQueue();
  const externalSharingAllowed = (ownerScopeId: ScopeId): Promise<boolean> =>
    deps.externalSharingAllowed?.(ownerScopeId) ?? Promise.resolve(false);
  async function assertShareAllowed(
    d: PublishedApp,
    grantee: ScopeId,
    permission: Permission | null,
    grantedBy: string,
  ) {
    if (permission === null) return;
    if (d.personalOnly)
      throw new DeployAccessError(
        "human_consent_required",
        "Share this private app explicitly before granting access.",
      );
    if (d.connectors && !samePerson(d.createdBy, grantedBy))
      throw new DeployAccessError(
        "forbidden",
        `only the person who published "${d.name ?? d.id}" can share it while it borrows their connectors`,
      );
    const { kind, ref } = parseScopeId(grantee);
    if (kind !== "personal" || !ref?.includes("@")) return;
    if ((await deps.canManageEmail?.(ref)) || (await externalSharingAllowed(d.ownerScopeId))) return;
    throw new DeployAccessError("external_sharing_disabled", EXTERNAL_APP_SHARING_OFF);
  }
  const recordAudit = (e: AuditEvent): void => recordAuditInBinding(deps.auditLog, e);
  async function withdrawLoan(d: PublishedApp, actor: string | undefined, detail: string): Promise<void> {
    if (!d.connectors) return;
    await deps.deployStore.setConnectors(d.id, undefined);
    recordAudit({
      at: Date.now(),
      principalId: actor ?? "unknown",
      action: "deploy_connectors",
      resource: appRef(d.id),
      scopeLabel: d.ownerScopeId,
      detail,
    });
  }
  async function withdrawLoanUnlessPublisher(d: PublishedApp, actor: string | undefined): Promise<void> {
    if (!samePerson(actor, d.createdBy))
      await withdrawLoan(d, actor, "withdrawn: someone other than the publisher changed the running version");
  }

  const eachRunning = (work: (d: PublishedApp) => Promise<void>) =>
    claimThenBind(deps.deployStore.claimTenants, async () => {
      for (const d of await deps.deployStore.list()) if (d.status === "running") await work(d);
    });
  function withDeployLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return deployQueue(id, () => advisoryLock.withLock(`deploy:${id}`, fn));
  }

  async function currentContext(context?: PrivateContext): Promise<PrivateContext | undefined> {
    if (!context) return undefined;
    if (context.sessionId && !deps.sessions) throw new Error("Conversation context is unavailable.");
    return deps.sessions ? refreshPrivateContext(deps.sessions, context) : context;
  }

  async function inheritAppContext(app: PublishedApp, context?: PrivateContext): Promise<void> {
    if (!context) return;
    await currentContext(context);
    if (app.personalOnly && !privateSourceAllowed(context, app.ownerScopeId))
      throw new DeployAccessError("forbidden", "App source is private to its owner's personal conversations.");
    if (deps.sessions && (await inheritContextSources(deps.sessions, context, [app])).has(app.id))
      throw new DeployAccessError("forbidden", "App source is private to its owner's personal conversations.");
  }

  async function creationContext(input: DeployInput): Promise<PrivateContext | undefined> {
    const context = await currentContext(input.context);
    if (
      context?.personalOnly &&
      (!privateSourceAllowed(context, input.ownerScopeId) ||
        input.ownerScopeId !== scopeId("personal", context.actorId) ||
        (input.createdInScope && input.createdInScope !== input.ownerScopeId))
    )
      throw new DeployAccessError("forbidden", "Private apps must be created in their owner's personal scope.");
    return context;
  }

  async function recordOutputContext(app: PublishedApp, incoming?: PrivateContext): Promise<void> {
    if (!incoming) return;
    await inheritAppContext(app, incoming);
    const context = incoming;
    const owner = scopeId("personal", context.actorId);
    if (
      context.personalOnly &&
      (!privateSourceAllowed(context, owner) ||
        app.ownerScopeId !== owner ||
        (app.createdInScope !== undefined && app.createdInScope !== owner) ||
        app.public ||
        (await grantsOn(ambientTenant(), app)).length)
    )
      throw new DeployAccessError(
        "forbidden",
        "Private context cannot update a shared app. Create a personal app instead.",
      );
    if (context.personalOnly || context.sourceProvenance) await deps.deployStore.recordContext(app.id, context);
  }

  const withAppEnv = async (d: PublishedApp, version: AppVersion): Promise<AppVersion> => {
    const appEnv = await deps.appEnv?.(d);
    return appEnv && Object.keys(appEnv).length ? { ...version, env: { ...version.env, ...appEnv } } : version;
  };

  const applyVersion = async (id: string, version: AppVersion, alwaysOn?: boolean): Promise<DeployEndpoint> => {
    const stored = (await deps.deployStore.get(id))!;
    const d = alwaysOn === undefined ? stored : { ...stored, alwaysOn };
    version = await withAppEnv(d, version);
    let endpoint: DeployEndpoint;
    if (deps.provider.reconcile && version.commit) {
      endpoint = await deps.provider.reconcile(d, version, await deps.deployStore.bundleOf(id, version.commit));
    } else {
      let materialized = version;
      if (version.commit) {
        const files = await deps.deployStore.filesOf(id, version.commit);
        materialized = { ...version, snapshotDir: await snapshotFiles(deps.deployDir, files) };
      }
      endpoint = await deps.provider.apply(d, materialized);
    }
    if (alwaysOn !== undefined) await deps.deployStore.setAlwaysOn(id, alwaysOn);
    if (endpoint.image && endpoint.image !== version.image) {
      await deps.deployStore.setVersionImage(id, version.version, endpoint.image);
    }
    return endpoint;
  };

  const markVersionRunning = async (
    id: string,
    version: number,
    endpoint: DeployEndpoint,
    placedCommit?: string,
  ): Promise<void> => {
    await deps.deployStore.setEndpoint(id, endpoint);
    await deps.deployStore.setStatus(id, "running");
    await deps.deployStore.setAppliedVersion(id, version, placedCommit);
  };

  const liveEdits = createLiveEdits({
    deployStore: deps.deployStore,
    provider: deps.provider,
    recordAudit,
    leaderLease,
    withDeployLock,
    applyVersion: (id, version) => applyVersion(id, version),
    markVersionRunning,
    withAppEnv,
  });

  const publishCommit = async (
    before: PublishedApp,
    commit: string,
    audit: { principalId: string; action: "deploy_git_push" | "deploy_version" },
  ): Promise<AppVersion | null> => {
    const v = await deps.deployStore.addVersionFromCommit(before.id, commit);
    if (!v) return null;
    await deps.deployStore.deleteDraft(before.id);
    const endpoint = await applyVersion(before.id, v);
    await markVersionRunning(before.id, v.version, endpoint);
    recordAudit({
      at: Date.now(),
      ...audit,
      resource: `${before.id}@v${v.version}`,
      scopeLabel: before.ownerScopeId,
    });
    return v;
  };

  const getApp = async (idOrName: string) =>
    (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));

  async function sourceReaderOf(d: PublishedApp): Promise<AppSourceReader | null> {
    const head = await liveEdits.savedHeadOf(d);
    if (!head) return null;
    const trees = new Map<string, Promise<AppSource["tree"]>>();
    return {
      commit: head.commit,
      async source(paths, commit = head.commit) {
        const tree = trees.get(commit) ?? deps.deployStore.commitTreeOf(d.id, commit);
        trees.set(commit, tree);
        return sourceOf(d.id, { commit, tree: await tree }, paths);
      },
    };
  }

  const sourceOf = async (
    id: string,
    saved: Pick<AppSource, "commit" | "tree">,
    paths: string[] = [],
  ): Promise<AppSource> => ({
    commit: saved.commit,
    tree: saved.tree.map(({ path, sha, size }) => ({ path, sha, size })),
    files: (
      await deps.deployStore.filesIn(
        id,
        saved.tree.filter((f) => paths.includes(f.path)),
      )
    ).map((f) => ({ path: f.path, data: bytes(f.data) })),
  });

  const liveEndpoint = async (d: PublishedApp): Promise<DeployEndpoint | null> => {
    if (!deps.provider.resolveEndpoint || d.endpoint == null) return d.endpoint;
    const version = currentVersionOf(d);
    if (!version) return d.endpoint;
    const resolved = await deps.provider.resolveEndpoint(d, version);
    if (resolved) {
      if (!endpointsEqual(resolved, d.endpoint)) await deps.deployStore.setEndpoint(d.id, resolved);
      return resolved;
    }
    return withDeployLock(d.id, async () => {
      const cur = await deps.deployStore.get(d.id);
      if (cur?.status !== "running") return null;
      const v = currentVersionOf(cur) ?? version;
      const again = await deps.provider.resolveEndpoint!(cur, v);
      if (again) {
        if (!endpointsEqual(again, cur.endpoint)) await deps.deployStore.setEndpoint(cur.id, again);
        return again;
      }
      const placed = (await liveEdits.runningVersion(cur)) ?? v;
      const fresh = await applyVersion(cur.id, placed);
      await markVersionRunning(cur.id, v.version, fresh, placed.commit);
      return fresh;
    });
  };

  const rotateApp = (id: string): Promise<void> =>
    withDeployLock(id, async () => {
      const cur = await deps.deployStore.get(id);
      if (!cur || cur.status !== "running" || !(await deps.provider.rotationDue?.(cur))) return;
      const v = currentVersionOf(cur);
      if (!v) return;
      const placed = (await liveEdits.runningVersion(cur)) ?? v;
      const endpoint = await applyVersion(cur.id, placed);
      await markVersionRunning(cur.id, v.version, endpoint, placed.commit);
      await deps.provider.park?.(cur).catch((e) => swallow("deploy: park rotated app", e));
    });

  const appRef = (id: string): string => encodeRef(deployRef(id));
  const grantsOn = (tenant: Tenant, d: PublishedApp): Promise<Grant[]> =>
    deps.acl.grantsFor(tenant, d.ownerScopeId, appRef(d.id));

  async function reachAllowed(d: PublishedApp, principalId: string): Promise<boolean> {
    if (!principalId) return false;
    const reaches = async (scope: ScopeId): Promise<boolean> => {
      if (deps.canReadScope) return deps.canReadScope(principalId, scope);
      const { kind, ref } = parseScopeId(scope);
      return kind === "org" || (kind === "personal" && samePerson(ref, principalId));
    };
    if (await reaches(d.ownerScopeId)) return true;
    for (const g of await grantsOn(ambientTenant(), d)) {
      if ((g.permission === "read" || g.permission === "write") && (await reaches(g.granteeScopeId))) return true;
    }
    return false;
  }

  async function canWriteScope(callerId: string, scope: ScopeId, actingScopeId?: ScopeId): Promise<boolean> {
    if (deps.canWriteScope) return deps.canWriteScope(callerId, scope);
    return scope === `personal:${callerId}` || scope === actingScopeId;
  }

  async function managesHome(d: PublishedApp, callerId: string, actingScopeId?: ScopeId): Promise<boolean> {
    if (d.ownerScopeId === `personal:${callerId}`) return true;
    if (deps.managesArtifactHome && (await deps.managesArtifactHome(d.ownerScopeId, d.createdBy, callerId)))
      return true;
    if (
      isManageableCreationScope(d.createdInScope) &&
      (await canWriteScope(callerId, d.createdInScope!, actingScopeId))
    )
      return true;
    return false;
  }

  async function canManage(d: PublishedApp, caller: PrivateContext, actingScopeId?: ScopeId): Promise<boolean> {
    if (
      d.personalOnly &&
      !privateSourceAllowed({ ...caller, scopeId: caller.scopeId ?? actingScopeId }, d.ownerScopeId)
    )
      return false;
    if (!(await personOrOwningBot(caller, async () => samePerson(d.createdBy, caller.actorId)))) return false;
    if (await managesHome(d, caller.actorId, actingScopeId)) return true;
    for (const grant of await grantsOn(ambientTenant(), d)) {
      if (grant.permission !== "write") continue;
      if (await canWriteScope(caller.actorId, grant.granteeScopeId, actingScopeId)) return true;
    }
    return false;
  }

  return {
    appUrl: (d) => appUrlOf(d, { sharedWebUrl: deps.publicWebUrl, appsDomain: deps.deployAppsDomain }),
    providerProfile: deps.provider.profile,
    assertShareAllowed,

    async deploy(input) {
      await creationContext(input);
      if (input.name !== undefined) {
        validateName(input.name);
        if (await deps.deployStore.getByName(input.name)) throw new Error(`app name taken: ${input.name}`);
      }
      const id = randomUUID();
      if (input.name === undefined) assertAppLabelFits(id);
      assertAppSize(fileSizes(input.files), deps.provider.profile.maxAppBytes);
      const snapshotDir = await snapshotFiles(deps.deployDir, input.files);
      const homeDir = input.homeFiles?.length ? await snapshotFiles(deps.deployDir, input.homeFiles) : undefined;
      const env = input.stampEnv ? { ...input.env, ...input.stampEnv } : input.env;
      const context = await creationContext(input);
      if (input.createdInScope && parseScopeId(input.createdInScope).kind === "channel") {
        await deps.acl.grant(ambientTenant(), {
          ownerScopeId: input.ownerScopeId,
          ref: appRef(id),
          granteeScopeId: input.createdInScope,
          permission: "read",
          grantedBy: input.createdBy,
        });
      }
      const d = await deps.deployStore.create({
        id,
        ownerScopeId: input.ownerScopeId,
        createdBy: input.createdBy,
        entrypoint: input.entrypoint,
        snapshotDir,
        files: input.files,
        ...(context?.personalOnly ? { personalOnly: true } : {}),
        ...(context?.sourceProvenance ? { sourceProvenance: context.sourceProvenance } : {}),
        ...(homeDir ? { homeDir } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.createdInScope !== undefined ? { createdInScope: input.createdInScope } : {}),
        ...(env ? { env } : {}),
        ...(input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : {}),
      });
      const endpoint = await applyVersion(d.id, d.versions[0]!);
      await markVersionRunning(d.id, d.versions[0]!.version, endpoint);
      recordAudit({
        at: Date.now(),
        principalId: input.createdBy,
        action: "deploy",
        resource: d.id,
        scopeLabel: input.ownerScopeId,
      });
      return (await deps.deployStore.get(d.id))!;
    },

    async redeploy(id, input) {
      return withDeployLock(id, async () => {
        const before = await deps.deployStore.get(id);
        if (!before) throw new Error(`unknown app: ${id}`);
        await recordOutputContext(before, input.context);
        await withdrawLoanUnlessPublisher(before, input.actor);
        const current = currentVersionOf(before);
        assertAppSize(fileSizes(input.files), deps.provider.profile.maxAppBytes);
        const inherited = input.env ?? current?.env;
        const env = input.stampEnv ? { ...inherited, ...input.stampEnv } : inherited;
        if (
          current &&
          input.entrypoint === current.entrypoint &&
          input.homeFiles === undefined &&
          (input.alwaysOn === undefined || input.alwaysOn === !!before.alwaysOn) &&
          envKey(env) === envKey(current.env)
        ) {
          const liveEdit = await liveEdits.save(before, input.actor ?? before.createdBy, { files: input.files });
          if (liveEdit) return { ...(await deps.deployStore.get(id))!, liveEdit };
        }
        await deps.deployStore.deleteDraft(id);
        const snapshotDir = await snapshotFiles(deps.deployDir, input.files);
        let homeDir = input.homeFiles === undefined ? current?.homeDir : undefined;
        if (input.homeFiles?.length) homeDir = await snapshotFiles(deps.deployDir, input.homeFiles);
        const v = await deps.deployStore.addVersion(id, {
          entrypoint: input.entrypoint,
          snapshotDir,
          files: input.files,
          ...(homeDir ? { homeDir } : {}),
          ...(env ? { env } : {}),
        });
        const endpoint = await applyVersion(id, v, input.alwaysOn);
        await markVersionRunning(id, v.version, endpoint);
        recordAudit({
          at: Date.now(),
          principalId: before.createdBy,
          action: "deploy_version",
          resource: `${id}@v${v.version}`,
          scopeLabel: before.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    getApp,

    listApps() {
      return deps.deployStore.list();
    },

    async rollbackApp(id, version, options) {
      return withDeployLock(id, async () => {
        const before = await deps.deployStore.get(id);
        if (before) {
          await recordOutputContext(before, options?.context);
          await withdrawLoanUnlessPublisher(before, options?.actor);
        }
        await deps.deployStore.deleteDraft(id);
        await deps.deployStore.setCurrentVersion(id, version);
        const v = await deps.deployStore.versionOf(id, version);
        const d = await deps.deployStore.get(id);
        if (!d || !v) return;
        const endpoint = await applyVersion(id, v, options?.alwaysOn);
        await markVersionRunning(id, v.version, endpoint);
        recordAudit({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_rollback",
          resource: `${id}@v${version}`,
          scopeLabel: d.ownerScopeId,
        });
      });
    },

    async archiveApp(id, context) {
      return withDeployLock(id, async () => {
        const d = await deps.deployStore.get(id);
        if (!d) return;
        await recordOutputContext(d, context);
        await deps.provider.destroy(d);
        await deps.deployStore.setStatus(id, "archived");
        await deps.deployStore.setEndpoint(id, null);
      });
    },

    async restoreApp(id, actorId, context) {
      return withDeployLock(id, async () => {
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown app: ${id}`);
        await recordOutputContext(d, context);
        if (d.status === "running") return d;
        if (d.status !== "archived") throw new Error(`app is not archived: ${id}`);
        const version = currentVersionOf(d);
        if (!version) throw new Error(`no such version ${d.currentVersion}`);
        try {
          const placed = (await liveEdits.runningVersion(d)) ?? version;
          const endpoint = await applyVersion(id, placed);
          await markVersionRunning(id, version.version, endpoint, placed.commit);
        } catch (error) {
          await deps.provider
            .destroy(d)
            .catch((cleanupError) => swallow("deploy restore runtime cleanup", cleanupError));
          await deps.deployStore
            .setStatus(id, "archived")
            .catch((cleanupError) => swallow("deploy restore status cleanup", cleanupError));
          await deps.deployStore
            .setEndpoint(id, null)
            .catch((cleanupError) => swallow("deploy restore endpoint cleanup", cleanupError));
          throw error;
        }
        recordAudit({
          at: Date.now(),
          principalId: actorId ?? d.createdBy,
          action: "deploy_restore",
          resource: `${id}@v${version.version}`,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async renameApp(id, name, context) {
      return withDeployLock(id, async () => {
        validateName(name);
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown app: ${id}`);
        await recordOutputContext(d, context);
        const clash = await deps.deployStore.getByName(name);
        if (clash && clash.id !== id) throw new Error(`app name taken: ${name}`);
        await deps.deployStore.setName(id, name);
        recordAudit({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_rename",
          resource: id,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async setAppDisplayName(id, displayName, context) {
      return withDeployLock(id, async () => {
        if (displayName) validateDisplayName(displayName);
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown app: ${id}`);
        await recordOutputContext(d, context);
        await deps.deployStore.setDisplayName(id, displayName || undefined);
        recordAudit({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_display_name",
          resource: id,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async setAppAlwaysOn(id, alwaysOn, context) {
      return withDeployLock(id, async () => {
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown app: ${id}`);
        await recordOutputContext(d, context);
        if (d.status === "running" && Boolean(d.alwaysOn) !== alwaysOn) await deps.provider.setAlwaysOn?.(d, alwaysOn);
        await deps.deployStore.setAlwaysOn(id, alwaysOn);
        recordAudit({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_always_on",
          resource: id,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async setAppEmbedAncestors(id, embedAncestors, context) {
      const ancestors = parseEmbedAncestors(embedAncestors);
      if (!ancestors) throw new Error(`embedAncestors must be an ${EMBED_ANCESTORS_HINT}`);
      return withDeployLock(id, async () => {
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown app: ${id}`);
        await recordOutputContext(d, context);
        await deps.deployStore.setEmbedAncestors(id, ancestors);
        recordAudit({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_embed_ancestors",
          resource: id,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async setAppConnectors(idOrName, connectors, actor) {
      const found = await getApp(idOrName);
      if (!found) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
      return withDeployLock(found.id, async () => {
        const d = await getApp(found.id);
        if (!d) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
        if (!samePerson(d.createdBy, actor.createdBy))
          throw new DeployAccessError("forbidden", "only the publisher can lend an app their connectors");
        await recordOutputContext(d, actor.context);
        const hosts = [...new Set(connectors.map((host) => host.toLowerCase()))].sort();
        const unknown = hosts.filter((host) => !CONNECTOR_HOSTS.includes(host));
        if (unknown.length)
          throw new DeployAccessError("unknown_connector", `not a connected-app host: ${unknown.join(", ")}`);
        if (hosts.length && d.public)
          throw new DeployAccessError("forbidden", "a public app cannot borrow connectors; make it restricted first");
        await deps.deployStore.setConnectors(d.id, hosts.length ? hosts : undefined);
        recordAudit({
          at: Date.now(),
          principalId: actor.createdBy,
          action: "deploy_connectors",
          resource: appRef(d.id),
          scopeLabel: d.ownerScopeId,
          detail: hosts.join(",") || "(none)",
        });
        return (await deps.deployStore.get(d.id))!;
      });
    },

    async setAppPublic(idOrName, isPublic, actor) {
      const found = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!found) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
      return withDeployLock(found.id, async () => {
        const d = await deps.deployStore.get(found.id);
        if (!d) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
        await this.assertAppOwner(d, actor);
        if (!actor.personAtKeyboard)
          throw new DeployAccessError(
            "human_consent_required",
            "Only the person can change app link access. Ask them to do it themselves.",
          );
        if (isPublic && d.personalOnly)
          throw new DeployAccessError(
            "human_consent_required",
            "Share this private app explicitly before enabling public access.",
          );
        if (isPublic && !(await externalSharingAllowed(d.ownerScopeId)))
          throw new DeployAccessError("external_sharing_disabled", EXTERNAL_APP_SHARING_OFF);
        if (isPublic && deps.publicLinksAvailable === false)
          throw new DeployAccessError("public_links_unavailable", PUBLIC_LINKS_UNAVAILABLE);
        if (isPublic && d.connectors)
          throw new DeployAccessError(
            "forbidden",
            "an app that borrows connectors cannot be public; withdraw them first",
          );
        await deps.deployStore.setPublic(d.id, isPublic);
        recordAudit({
          at: Date.now(),
          principalId: actor.createdBy,
          action: isPublic ? "deploy_public_enable" : "deploy_public_disable",
          resource: appRef(d.id),
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(d.id))!;
      });
    },

    async maintainApps() {
      const result = await leaderLease.hold("deployments:keep-warm", async () => {
        let maintained = 0;
        await eachRunning(async (listed) => {
          try {
            const rotate = await deps.provider.rotationDue?.(listed);
            const cur = rotate || listed.alwaysOn ? await deps.deployStore.get(listed.id) : null;
            if (cur?.status !== "running") return;
            if (rotate) await rotateApp(cur.id);
            if (rotate || (cur.alwaysOn && (await liveEndpoint(cur)))) maintained++;
          } catch (e) {
            console.error("%s", `[deploy] maintenance failed for ${listed.id}:`, errMessage(e));
          }
        });
        return maintained;
      });
      return result ?? 0;
    },

    publishDueLiveEdits: () => liveEdits.publishDue(),

    async liveEditOf(idOrName) {
      if (!deps.provider.liveEdit) return null;
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      return d ? { draft: await deps.deployStore.draftOf(d.id) } : null;
    },

    async reachApp(idOrName, principalId, opts = {}): Promise<Reach> {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d || d.status !== "running" || d.endpoint == null) return { status: "not_found" };
      if (!opts.bypassAcl && !(await reachAllowed(d, principalId))) return { status: "denied" };
      const endpoint = await liveEndpoint(d);
      if (!endpoint) return { status: "not_found" };
      await deps.deployStore.touch(d.id, Date.now()).catch((e) => swallow("deploy reach touch", e));
      return { status: "ok", id: d.id, endpoint };
    },

    async appLogs(idOrName, opts): Promise<string | null> {
      if (!deps.provider.logs) return null;
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d || d.status !== "running") return null;
      return deps.provider.logs(d, opts);
    },

    async gitRepoPath(idOrName) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      return d ? await deps.deployStore.repoUrl(d.id) : null;
    },

    async readApp(id, read) {
      const found = await getApp(id);
      if (!found) return read(null);
      return withDeployLock(found.id, async () => read(await getApp(found.id)));
    },

    async pushGit(id, runReceivePack, actor) {
      const context = typeof actor === "string" ? undefined : actor;
      const actorId = typeof actor === "string" ? actor : actor?.actorId;
      return withDeployLock(id, async () => {
        const current = await deps.deployStore.get(id);
        if (!current) throw new DeployAccessError("not_found", `no such app: ${id}`);
        await recordOutputContext(current, context);
        const { result, ok } = await runReceivePack();
        if (!ok) return result;
        let ownerScopeId = "unknown";
        try {
          const before = await deps.deployStore.get(id);
          if (!before) return result;
          ownerScopeId = before.ownerScopeId;
          const pushed = await deps.deployStore.refOf(id, deployCurrentGitRef);
          if (!pushed) return result;
          const tree = await deps.deployStore.commitTreeOf(id, pushed);
          assertAppSize(
            tree.map((f) => f.size),
            deps.provider.profile.maxAppBytes,
          );
          await withdrawLoanUnlessPublisher(before, actorId);
          if (await liveEdits.save(before, actorId ?? before.createdBy, { commit: pushed })) return result;
          await publishCommit(before, pushed, { principalId: before.createdBy, action: "deploy_git_push" });
        } catch (e) {
          reportFailure("deploy: register pushed version", e, `deployment=${id}`);
          recordAudit({
            at: Date.now(),
            principalId: "system",
            action: "deploy_git_push_failed",
            resource: id,
            scopeLabel: ownerScopeId,
            status: "error",
          });
        }
        return result;
      });
    },

    async source(idOrName, paths, commit) {
      const d = await getApp(idOrName);
      const reader = d ? await sourceReaderOf(d) : null;
      return reader ? reader.source(paths, commit) : null;
    },

    async sourceReader(idOrName, caller, actingScopeId) {
      const found = await getApp(idOrName);
      if (!found) return null;
      return withDeployLock(found.id, async () => {
        const d = await getApp(found.id);
        if (!d || !(await canManage(d, caller, actingScopeId))) return null;
        await inheritAppContext(d, caller);
        const reader = await sourceReaderOf(d);
        return reader
          ? {
              commit: reader.commit,
              source: (paths, commit) =>
                withDeployLock(d.id, async () => {
                  const current = await getApp(d.id);
                  if (!current || !(await canManage(current, caller, actingScopeId)))
                    throw new DeployAccessError("forbidden", "App source access is no longer available.");
                  await inheritAppContext(current, caller);
                  return reader.source(paths, commit);
                }),
            }
          : null;
      });
    },

    async editSource(idOrName, actor, edit) {
      const context = typeof actor === "string" ? undefined : actor;
      const actorId = typeof actor === "string" ? actor : actor.actorId;
      const found = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!found) throw new Error(`no such app: ${idOrName}`);
      return withDeployLock(found.id, async () => {
        const before = await deps.deployStore.get(found.id);
        const saved = before ? await liveEdits.savedOf(before) : null;
        if (!before || !saved) throw new Error(`${idOrName} has no saved source; publish it again first`);
        await recordOutputContext(before, context);
        const wanted = await edit((paths) => sourceOf(before.id, saved, paths));
        await recordOutputContext(before, context);
        const written = wanted.files.map((f) => ({ path: normalizeRelPath(f.path), data: bytes(f.data) }));
        const change = await liveEdits.changeOf(before.id, saved, {
          written,
          deletedPaths: wanted.deletedPaths.map(normalizeRelPath),
        });
        const done = { saved: change.changed, deleted: change.deletedPaths, version: before.currentVersion };
        if (!change.changed.length && !change.deletedPaths.length) return done;
        const touched = new Set([...change.deletedPaths, ...change.changed.map((f) => f.path)]);
        assertAppSize(
          [
            ...saved.tree.filter((f) => !touched.has(f.path)).map((f) => f.size),
            ...written.filter((f) => touched.has(f.path)).map((f) => f.data.byteLength),
          ],
          deps.provider.profile.maxAppBytes,
        );
        await withdrawLoanUnlessPublisher(before, actorId);
        const liveEdit = await liveEdits.save(before, actorId, change);
        if (liveEdit) return { ...done, liveEdit };
        const commit = await change.next.commit();
        const published = await publishCommit(before, commit, { principalId: actorId, action: "deploy_version" });
        return { ...done, version: published?.version ?? before.currentVersion };
      });
    },

    async reapIdleApps(ttlMs, now = Date.now()) {
      const result = await leaderLease.hold("deployments:reaper", async () => {
        if (deps.provider.profile.managedScaleToZero) return 0;
        let stopped = 0;
        await eachRunning(async ({ id, alwaysOn, lastAccessAt, versions }) => {
          if (alwaysOn || now - (lastAccessAt ?? versions.at(-1)?.createdAt ?? 0) < ttlMs) return;
          await withDeployLock(id, async () => {
            const cur = await deps.deployStore.get(id);
            if (!cur || cur.status !== "running" || cur.alwaysOn) return;
            await deps.provider.destroy(cur);
            await deps.deployStore.setStatus(id, "stopped");
            await deps.deployStore.setEndpoint(id, null);
            stopped++;
          });
        });
        return stopped;
      });
      return result ?? 0;
    },

    async deployOrUpdate(input) {
      const { ownerScopeId, createdBy } = input;
      const caller = { ...input.context, actorId: createdBy, botActor: input.botActor };
      if (input.embedAncestors !== undefined && !parseEmbedAncestors(input.embedAncestors))
        throw new Error(`embedAncestors must be an ${EMBED_ANCESTORS_HINT}`);

      if (input.renameFrom !== undefined) {
        if (input.name === undefined) throw new Error("rename requires a target name");
        validateName(input.name);
        const existing = await deps.deployStore.getByName(input.renameFrom);
        if (!existing) throw new Error(`no app named: ${input.renameFrom}`);
        if (!(await canManage(existing, caller, input.createdInScope)))
          throw new Error(`not authorized to manage app: ${input.renameFrom}`);
        const clash = await deps.deployStore.getByName(input.name);
        if (clash && clash.id !== existing.id) throw new Error(`app name taken: ${input.name}`);
        await withDeployLock(existing.id, async () => {
          const current = await deps.deployStore.get(existing.id);
          if (!current) throw new Error(`unknown app: ${existing.id}`);
          await recordOutputContext(current, input.context);
          await deps.deployStore.setName(existing.id, input.name!);
        });
        recordAudit({
          at: Date.now(),
          principalId: createdBy,
          action: "deploy_rename",
          resource: existing.id,
          scopeLabel: existing.ownerScopeId,
        });
        let liveEdit: LiveEditSaved | undefined;
        if (input.files?.length) {
          const entrypoint = requiredEntrypoint(input.entrypoint, existing);
          ({ liveEdit } = await this.redeploy(existing.id, {
            actor: createdBy,
            context: input.context,
            entrypoint,
            files: input.files,
            ...(input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : {}),
            ...(input.homeFiles ? { homeFiles: input.homeFiles } : {}),
            ...(input.env ? { env: input.env } : {}),
            ...(input.stampEnv ? { stampEnv: input.stampEnv } : {}),
          }));
        } else if (input.alwaysOn !== undefined) await this.setAppAlwaysOn(existing.id, input.alwaysOn, input.context);
        if (input.embedAncestors !== undefined)
          await this.setAppEmbedAncestors(existing.id, input.embedAncestors, input.context);
        return { ...(await deps.deployStore.get(existing.id))!, ...(liveEdit ? { liveEdit } : {}) };
      }

      if (input.rollbackTo !== undefined) {
        if (input.name === undefined) throw new Error("rollback requires the app name");
        const existing = await deps.deployStore.getByName(input.name);
        if (!existing) throw new Error(`no app named: ${input.name}`);
        if (!(await canManage(existing, caller, input.createdInScope)))
          throw new Error(`not authorized to manage app: ${input.name}`);
        await this.rollbackApp(existing.id, input.rollbackTo, {
          context: input.context,
          actor: createdBy,
          ...(input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : {}),
        });
        if (input.embedAncestors !== undefined)
          await this.setAppEmbedAncestors(existing.id, input.embedAncestors, input.context);
        return (await deps.deployStore.get(existing.id))!;
      }

      const files = input.files ?? [];
      const existing = input.name !== undefined ? await deps.deployStore.getByName(input.name) : null;
      if (existing) {
        if (existing.ownerScopeId !== ownerScopeId && !(await canManage(existing, caller, input.createdInScope))) {
          throw new Error(`app name taken: ${input.name}`);
        }
        if (!(await personOrOwningBot(caller, async () => samePerson(existing.createdBy, caller.actorId))))
          throw new Error(`not authorized to manage app: ${input.name}`);
        const entrypoint = requiredEntrypoint(input.entrypoint, existing);
        const { liveEdit } = await this.redeploy(existing.id, {
          actor: createdBy,
          context: input.context,
          entrypoint,
          files,
          ...(input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : {}),
          ...(input.homeFiles ? { homeFiles: input.homeFiles } : {}),
          ...(input.env ? { env: input.env } : {}),
          ...(input.stampEnv ? { stampEnv: input.stampEnv } : {}),
        });
        if (input.embedAncestors !== undefined)
          await this.setAppEmbedAncestors(existing.id, input.embedAncestors, input.context);
        return { ...(await deps.deployStore.get(existing.id))!, ...(liveEdit ? { liveEdit } : {}) };
      }
      const d = await this.deploy({
        context: input.context,
        ownerScopeId,
        createdBy,
        entrypoint: requiredEntrypoint(input.entrypoint, existing),
        files,
        ...(input.homeFiles ? { homeFiles: input.homeFiles } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.createdInScope !== undefined ? { createdInScope: input.createdInScope } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.stampEnv ? { stampEnv: input.stampEnv } : {}),
        ...(input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : {}),
      });
      if (input.embedAncestors !== undefined)
        await this.setAppEmbedAncestors(d.id, input.embedAncestors, input.context);
      return (await deps.deployStore.get(d.id))!;
    },

    async assertAppOwner(d, actor) {
      const caller = { actorId: actor.createdBy, botActor: actor.botActor };
      if (
        d.ownerScopeId !== scopeId("personal", actor.createdBy) ||
        !(await personOrOwningBot(caller, async () => samePerson(d.createdBy, actor.createdBy)))
      )
        throw new DeployAccessError("forbidden", "only the owner can change app access");
    },

    async canManageApp(idOrName, caller, actingScopeId) {
      const d = await getApp(idOrName);
      if (!d) return false;
      return canManage(d, caller, actingScopeId);
    },

    async appGrantees(idOrName) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d) return [];
      return (await grantsOn(ambientTenant(), d)).map((g) => ({ scope: g.granteeScopeId, permission: g.permission }));
    },

    async grantAppAccess(grant) {
      const ref = parseRef(grant.ref);
      if (ref.kind !== "deploy") throw new DeployAccessError("forbidden", "Expected an app grant.");
      const id = ref.id;
      return withDeployLock(id, async () => {
        const app = await deps.deployStore.get(id);
        if (!app || app.ownerScopeId !== grant.ownerScopeId)
          throw new DeployAccessError("not_found", "The app's current owner does not match the grant.");
        await assertShareAllowed(app, grant.granteeScopeId, grant.permission, grant.grantedBy);
        await deps.acl.grant(ambientTenant(), grant, app.createdBy);
      });
    },

    async shareApp(idOrName, grantee, permission, actor, opts) {
      const found = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!found) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
      return withDeployLock(found.id, async () => {
        const d = await deps.deployStore.get(found.id);
        if (!d) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
        await this.assertAppOwner(d, actor);
        grantee = await appShareScope(grantee, permission, deps.canManageEmail);
        await assertShareAllowed(d, grantee, permission, actor.createdBy);
        const ref = appRef(d.id);
        const tenant = ambientTenant();
        await deps.acl.revoke(tenant, d.ownerScopeId, ref, grantee, actor.createdBy);
        if (permission === null) {
          deps.auditLog.record(tenant, {
            at: Date.now(),
            principalId: actor.createdBy,
            action: "deploy_unshare",
            resource: ref,
            scopeLabel: grantee,
          });
        } else {
          await deps.acl.grant(tenant, {
            ownerScopeId: d.ownerScopeId,
            ref,
            granteeScopeId: grantee,
            permission,
            grantedBy: actor.createdBy,
          });
          deps.auditLog.record(tenant, {
            at: Date.now(),
            principalId: actor.createdBy,
            action: "deploy_share",
            resource: ref,
            scopeLabel: grantee,
          });
        }
        if (opts?.notify !== false) await notifyAppShared(deps, d, grantee, permission, actor.createdBy);
        return (await grantsOn(tenant, d)).map((g) => ({ scope: g.granteeScopeId, permission: g.permission }));
      });
    },

    async transferAppOwner(idOrName, toScope, actor) {
      const found = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!found) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
      return withDeployLock(found.id, async () => {
        const d = await deps.deployStore.get(found.id);
        if (!d) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
        if (!(await managesHome(d, actor.callerId, actor.actingScopeId))) {
          throw new DeployAccessError("forbidden", "only the owner can transfer an app");
        }
        if (d.ownerScopeId === toScope) return d;
        if (d.personalOnly)
          throw new DeployAccessError(
            "human_consent_required",
            "Share this private app explicitly before transferring it.",
          );
        if (toScope !== scopeId("personal", d.createdBy))
          await withdrawLoan(d, actor.callerId, "withdrawn: the app moved out of its publisher's library");
        const ref = appRef(d.id);
        const fromScope = d.ownerScopeId;
        const tenant = ambientTenant();
        const prior = await grantsOn(tenant, d);
        const newOwnerId = parseScopeId(toScope).kind === "personal" ? parseScopeId(toScope).ref! : actor.callerId;
        const oldOwnerId = parseScopeId(fromScope).kind === "personal" ? parseScopeId(fromScope).ref! : actor.callerId;
        for (const g of prior) {
          if (g.granteeScopeId === toScope) continue;
          await deps.acl.grant(tenant, { ...g, ownerScopeId: toScope, grantedBy: newOwnerId }, d.createdBy);
        }
        await deps.acl.grant(
          tenant,
          { ownerScopeId: toScope, ref, granteeScopeId: fromScope, permission: "write", grantedBy: newOwnerId },
          d.createdBy,
        );
        await deps.deployStore.setOwnerScope(d.id, toScope);
        for (const g of prior) await deps.acl.revoke(tenant, fromScope, ref, g.granteeScopeId, oldOwnerId, d.createdBy);
        deps.auditLog.record(tenant, {
          at: Date.now(),
          principalId: actor.callerId,
          action: "deploy_transfer",
          resource: ref,
          scopeLabel: toScope,
        });
        return (await deps.deployStore.get(d.id))!;
      });
    },
  };
}

function envKey(env: Record<string, string> | undefined): string {
  return JSON.stringify(Object.entries(env ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

function endpointsEqual(a: DeployEndpoint, b: DeployEndpoint | null): boolean {
  return b != null && JSON.stringify(a) === JSON.stringify(b);
}

async function snapshotFiles(deployDir: string, files: DeployFile[]): Promise<string> {
  const dir = join(deployDir, randomUUID());
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    const target = resolve(dir, normalizeRelPath(f.path));
    const rel = relative(dir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`deploy file escapes snapshot: ${f.path}`);
    await mkdir(dirname(target), { recursive: true });
    if (typeof f.data === "string") await writeFile(target, f.data, "utf8");
    else await writeFile(target, Buffer.from(f.data));
  }
  return dir;
}
