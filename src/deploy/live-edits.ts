import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditLog } from "../audit/audit-log.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { claimThenBind } from "../tenants/claim.ts";
import { errMessage, reportFailure } from "../util/errors.ts";
import { bytes, normalizeRelPath } from "./deploy-fs.ts";
import type { DeployProvider } from "./deploy-provider.ts";
import {
  currentVersionOf,
  type DeployEndpoint,
  type DeployStore,
  type Deployment,
  type DeploymentDraft,
  type DeploymentVersion,
} from "./deploy-store.ts";

export const LIVE_EDIT_PUBLISH_DELAY_MS = 2 * 60_000;

const DEV_INSTALL = "npm install --no-audit --no-fund";
const DEPENDENCY_MANIFESTS = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json"]);
const devScript = z.object({ scripts: z.object({ dev: z.string().trim().min(1) }) });

export interface LiveEditSaved {
  changed: number;
  hot: boolean;
  first?: boolean;
  publishAt?: number;
  previousFailure?: string;
}

interface LiveEditDeps {
  deployStore: DeployStore;
  provider: DeployProvider;
  auditLog: AuditLog;
  leaderLease: LeaderLease;
  publishDelayMs?: number;
  withDeployLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
  applyVersion(id: string, version: DeploymentVersion): Promise<DeployEndpoint>;
  markVersionRunning(id: string, version: number, endpoint: DeployEndpoint): Promise<void>;
  withDeploymentEnv(d: Deployment, version: DeploymentVersion): Promise<DeploymentVersion>;
}

type AppFile = { path: string; data: Uint8Array };
type SavedSource =
  | { files: ReadonlyArray<{ path: string; data: string | Uint8Array }> }
  | { commit: string }
  | { changed: readonly AppFile[]; deletedPaths: readonly string[] };

interface Snapshot {
  tree: Map<string, string>;
  read(paths: string[]): Promise<AppFile[]>;
  commit(base: string): Promise<string>;
}

export function gitBlobSha(data: Uint8Array): string {
  return createHash("sha1").update(`blob ${data.byteLength}\0`).update(data).digest("hex");
}

function devEntrypoint(files: readonly AppFile[]): string | undefined {
  const manifest = files.find((f) => f.path === "package.json");
  if (!manifest) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(manifest.data).toString("utf8"));
  } catch {
    return undefined;
  }
  return devScript.safeParse(parsed).success ? `${DEV_INSTALL} && npm run dev` : undefined;
}

function draftVersion(current: DeploymentVersion, draft: DeploymentDraft): DeploymentVersion {
  return { ...current, commit: draft.commit, entrypoint: draft.entrypoint };
}

export function createLiveEdits(deps: LiveEditDeps) {
  const store = deps.deployStore;
  const publishDelayMs = deps.publishDelayMs ?? LIVE_EDIT_PUBLISH_DELAY_MS;

  async function runningVersion(d: Deployment): Promise<DeploymentVersion | undefined> {
    const current = currentVersionOf(d);
    const draft = current && deps.provider.liveEdit ? await store.draftOf(d.id) : null;
    return current && draft ? draftVersion(current, draft) : current;
  }

  async function snapshotOf(
    id: string,
    source: SavedSource,
    base: string,
    known: Map<string, string>,
  ): Promise<Snapshot> {
    if ("changed" in source) {
      const { changed, deletedPaths } = source;
      const tree = new Map(known);
      for (const path of deletedPaths) tree.delete(path);
      for (const f of changed) tree.set(f.path, gitBlobSha(f.data));
      return {
        tree,
        read: async (paths) => {
          const kept = paths.filter((path) => !changed.some((f) => f.path === path));
          const unchanged = kept.length ? await store.filesOf(id, base, kept) : [];
          return [
            ...changed.filter((f) => paths.includes(f.path)),
            ...unchanged.map((f) => ({ path: f.path, data: bytes(f.data) })),
          ];
        },
        commit: () => store.commitDraft(id, [...changed], base, [...deletedPaths]),
      };
    }
    if ("commit" in source) {
      const tree = new Map((await store.commitTreeOf(id, source.commit)).map((f) => [f.path, f.sha]));
      return {
        tree,
        read: async (paths) =>
          (await store.filesOf(id, source.commit, paths)).map((f) => ({ path: f.path, data: bytes(f.data) })),
        commit: async () => {
          await store.keepCommit(id, source.commit);
          return source.commit;
        },
      };
    }
    const files = source.files.map((f) => ({ path: normalizeRelPath(f.path), data: bytes(f.data) }));
    return {
      tree: new Map(files.map((f) => [f.path, gitBlobSha(f.data)])),
      read: async (paths) => files.filter((f) => paths.includes(f.path)),
      commit: (base) => store.commitDraft(id, files, base),
    };
  }

  async function save(before: Deployment, actor: string, source: SavedSource): Promise<LiveEditSaved | null> {
    const current = currentVersionOf(before);
    const liveEdit = deps.provider.liveEdit;
    if (!liveEdit || before.status !== "running" || !current?.commit) return null;
    const draft = await store.draftOf(before.id);
    const base = draft?.commit ?? current.commit;
    const known = new Map((await store.commitTreeOf(before.id, base)).map((f) => [f.path, f.sha]));
    const next = await snapshotOf(before.id, source, base, known);
    const changedPaths = [...next.tree].filter(([path, sha]) => known.get(path) !== sha).map(([path]) => path);
    const deletedPaths = [...known.keys()].filter((path) => !next.tree.has(path));
    if (!changedPaths.length && !deletedPaths.length)
      return {
        changed: 0,
        hot: draft?.hot ?? false,
        ...(draft?.publishAt !== undefined ? { publishAt: draft.publishAt } : {}),
        ...(draft?.failure ? { previousFailure: draft.failure } : {}),
      };
    const read = await next.read(next.tree.has("package.json") ? [...changedPaths, "package.json"] : changedPaths);
    const changed = read.filter((f) => changedPaths.includes(f.path));
    const dev = devEntrypoint(read);
    const hot = dev !== undefined;
    const switched = draft?.hot !== hot;
    const restart = !hot || switched || changed.some((f) => DEPENDENCY_MANIFESTS.has(f.path));
    const target = { ...current, entrypoint: dev ?? current.entrypoint };
    const [committed, edited] = await Promise.allSettled([
      next.commit(base),
      deps
        .withDeploymentEnv(before, target)
        .then((version) => liveEdit(before, version, { files: changed, deletedPaths, restart })),
    ]);
    if (committed.status === "rejected")
      throw edited.status === "rejected"
        ? new AggregateError(
            [committed.reason, edited.reason],
            "saving the edit and writing it into the app both failed",
          )
        : committed.reason;
    const now = Date.now();
    const publishAt = now + publishDelayMs;
    const saved: DeploymentDraft = {
      deploymentId: before.id,
      commit: committed.value,
      entrypoint: target.entrypoint,
      hot,
      savedBy: actor,
      savedAt: now,
      publishAt,
      reloads: (draft?.reloads ?? 0) + (!hot || switched ? 1 : 0),
    };
    await store.putDraft(saved).catch((put: unknown) => {
      throw edited.status === "rejected" ? new AggregateError([put, edited.reason], "saving the edit failed") : put;
    });
    deps.auditLog.record({
      at: now,
      principalId: actor,
      action: "deploy_live_edit",
      resource: `${before.id}@${saved.commit}`,
      scopeLabel: before.ownerScopeId,
    });
    if (edited.status === "rejected") throw edited.reason;
    if (!edited.value) {
      const endpoint = await deps.applyVersion(before.id, { ...target, commit: saved.commit });
      await store.setEndpoint(before.id, endpoint);
    }
    return {
      changed: changed.length + deletedPaths.length,
      hot,
      ...(draft ? {} : { first: true }),
      publishAt,
      ...(draft?.failure ? { previousFailure: draft.failure } : {}),
    };
  }

  const publish = (id: string): Promise<boolean> =>
    deps.withDeployLock(id, async () => {
      const d = await store.get(id);
      const draft = await store.draftOf(id);
      if (!d || d.status !== "running" || !draft?.publishAt || draft.publishAt > Date.now()) return false;
      const current = currentVersionOf(d);
      if (!current) {
        await store.deleteDraft(id);
        return false;
      }
      try {
        const endpoint =
          draft.hot || !d.endpoint ? await deps.applyVersion(id, { ...current, commit: draft.commit }) : d.endpoint;
        const v = (await store.addVersionFromCommit(id, draft.commit)) ?? current;
        await deps.markVersionRunning(id, v.version, endpoint);
        await store.deleteDraft(id);
        deps.auditLog.record({
          at: Date.now(),
          principalId: draft.savedBy,
          action: "deploy_version",
          resource: `${id}@v${v.version}`,
          scopeLabel: d.ownerScopeId,
        });
        return true;
      } catch (e) {
        const restore = await deps.applyVersion(id, draftVersion(current, draft)).then(
          () => [],
          (r: unknown) => [r],
        );
        const failure = [e, ...restore].map(errMessage).join("; putting the saved edits back also failed: ");
        deps.auditLog.record({
          at: Date.now(),
          principalId: draft.savedBy,
          action: "deploy_version",
          resource: `${id}@${draft.commit}`,
          scopeLabel: d.ownerScopeId,
          status: "failed",
          detail: failure,
        });
        await store
          .putDraft({ ...draft, publishAt: undefined, failure, reloads: draft.reloads + 1 })
          .catch((put: unknown) => {
            throw new AggregateError([e, ...restore, put], "publishing the saved edits failed and recording it failed");
          });
        return false;
      }
    });

  async function publishDue(): Promise<number> {
    const published = await deps.leaderLease.hold("deployments:live-edits", async () => {
      const perTenant = await claimThenBind(store.claimDraftTenants, async () => {
        const due = (await store.drafts()).filter((d) => d.publishAt !== undefined && d.publishAt <= Date.now());
        const done = await Promise.all(
          due.map((draft) =>
            publish(draft.deploymentId).catch((e: unknown) => {
              reportFailure("deploy: publish live edits", e, `deployment=${draft.deploymentId}`);
              return false;
            }),
          ),
        );
        return done.filter(Boolean).length;
      });
      return perTenant.reduce((sum, n) => sum + n, 0);
    });
    return published ?? 0;
  }

  return { runningVersion, save, publishDue };
}
