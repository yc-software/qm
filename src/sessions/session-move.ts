import { randomUUID } from "node:crypto";
import type { CronStore } from "../cron/cron-store.ts";
import type { LoopStore } from "../loops/loop-store.ts";
import type { MonitorStore } from "../monitors/monitor-store.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import { reconcileProcesses } from "../processes/reconcile.ts";
import { supportsProcessSessions, type Sandbox } from "../sandbox/sandbox.ts";
import type { Tenant } from "../tenants/context.ts";
import { postsInto } from "../triggers/trigger-store.ts";
import type { ChildIsolation, Principal, ScopeId, Session, SpawnMeta } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import type { WebhookStore } from "../webhooks/webhook-store.ts";
import type { SessionStore } from "./session-store.ts";

interface MoveTarget {
  groupRef: string;
  channelName: string;
  audience: Principal[];
  version: string | undefined;
}

function rehomedSpawnMeta(
  meta: SpawnMeta,
  target: MoveTarget,
  computers: ReadonlyMap<string, string | null>,
): SpawnMeta {
  const { isPrivate: _isPrivate, isMpim: _isMpim, teamIds: _teamIds, ...conversation } = meta.conversation;
  const { scopeVersion: _scopeVersion, isolation, ...rest } = meta;
  const rebound = (child: ChildIsolation): ChildIsolation => {
    const computer = child.sandboxId ? computers.get(child.sandboxId) : undefined;
    if (computer === undefined) return child;
    const { sandboxId: _sandboxId, ...kept } = child;
    return computer ? { ...kept, sandboxId: computer } : kept;
  };
  return {
    ...rest,
    conversation: {
      ...conversation,
      kind: "group",
      channelRef: target.groupRef,
      channelName: target.channelName,
      audience: target.audience,
      publishMembers: target.audience,
    },
    sessionParticipantIds: target.audience.map((principal) => principal.id),
    ...(target.version ? { scopeVersion: target.version } : {}),
    ...(isolation ? { isolation: rebound(isolation) } : {}),
  };
}

function newReaders(memberIds: readonly string[], readers: readonly (readonly string[])[]): string[] {
  return memberIds.filter((member) => readers.some((sessionReaders) => !sessionReaders.includes(member)));
}

export interface ChatMoveDeps {
  sessions: Pick<SessionStore, "descendantsOf" | "getMany" | "participantsOfMany" | "rehome">;
  processes?: ProcessRegistry;
  sandbox?: Sandbox;
  crons: Pick<CronStore, "rehome">;
  webhooks: Pick<WebhookStore, "rehome">;
  monitors?: Pick<MonitorStore, "rehome">;
  loops?: Pick<LoopStore, "ownedBy" | "update">;
}

export type ChatTree = readonly Session[];

export interface JobHold {
  purpose: string;
  chat?: string;
}

export async function chatTrees(deps: ChatMoveDeps, roots: readonly Session[]): Promise<ChatTree[]> {
  if (!roots.length) return [];
  const descendants = await deps.sessions.descendantsOf(roots.map((s) => s.id));
  const children = descendants.length
    ? await deps.sessions.getMany({ ids: descendants.map((d) => d.id), threadRefs: [] })
    : [];
  const rootOf = new Map(descendants.map((d) => [d.id, d.rootId]));
  return roots.map((root) => [root, ...children.filter((child) => rootOf.get(child.id) === root.id)]);
}

async function liveJobs(deps: ChatMoveDeps, trees: readonly ChatTree[]) {
  const threadRefs = new Set(trees.flatMap((tree) => tree.map((s) => s.threadRef)));
  const scopes = [...new Set(trees.map((tree) => tree[0]!.scopeId))];
  const jobs = await Promise.all(scopes.map((scope) => deps.processes?.listByScope(scope) ?? []));
  return jobs
    .flat()
    .filter(
      (rec) =>
        rec.kind === "background" && rec.status === "running" && rec.sessionRef && threadRefs.has(rec.sessionRef),
    );
}

export async function settleChatJobs(deps: ChatMoveDeps, trees: readonly ChatTree[]): Promise<void> {
  const { processes, sandbox } = deps;
  if (!processes || !sandbox || !supportsProcessSessions(sandbox)) return;
  const hosts = new Map(
    (await liveJobs(deps, trees)).flatMap((rec) => (rec.sandboxId ? [[rec.sandboxId, rec.scopeId]] : [])),
  );
  await Promise.all(
    [...hosts].map(([sandboxId, scopeId]) =>
      (async () => {
        const handle = await sandbox.provision(scopeId, { sandboxId });
        try {
          await reconcileProcesses(sandbox, handle, processes, scopeId);
        } finally {
          await sandbox
            .teardown(handle, { keepWarm: true })
            .catch(swallowAs("session move: release job computer", undefined));
        }
      })().catch(swallowAs("session move: check a moving chat's jobs", undefined)),
    ),
  );
}

export async function runningJobs(deps: ChatMoveDeps, trees: readonly ChatTree[]): Promise<Map<string, JobHold>> {
  const holds = new Map<string, JobHold>();
  const jobs = await liveJobs(deps, trees);
  for (const tree of trees) {
    const job = jobs.find((rec) => tree.some((s) => s.threadRef === rec.sessionRef));
    if (!job) continue;
    const chat = tree.find((s) => s.threadRef === job.sessionRef);
    holds.set(tree[0]!.id, {
      purpose: job.purpose ?? job.command.replace(/^bg: /, ""),
      ...(chat && chat !== tree[0] && chat.title ? { chat: chat.title } : {}),
    });
  }
  return holds;
}

export async function newChatReaders(
  deps: ChatMoveDeps,
  tenant: Tenant,
  trees: readonly ChatTree[],
  members: readonly string[],
  sourceMembers: ReadonlyMap<ScopeId, readonly string[]>,
): Promise<string[]> {
  const participants = await deps.sessions.participantsOfMany(
    tenant,
    trees.flatMap((tree) => tree.map((s) => s.id)),
  );
  const readers = trees.flatMap((tree) => {
    const scopeMembers = sourceMembers.get(tree[0]!.scopeId);
    return tree.map((s) => (participants.get(s.id) ?? []).filter((id) => !scopeMembers || scopeMembers.includes(id)));
  });
  return newReaders(members, readers);
}

export async function carryChatsAlong(
  deps: ChatMoveDeps,
  tenant: Tenant,
  trees: readonly ChatTree[],
  to: ScopeId,
  members: readonly string[],
  target: MoveTarget,
): Promise<void> {
  const bySource = new Map<ScopeId, Set<string>>();
  for (const tree of trees)
    for (const s of tree)
      bySource.set(tree[0]!.scopeId, (bySource.get(tree[0]!.scopeId) ?? new Set()).add(s.threadRef));
  const loops = deps.loops;
  await Promise.all(
    [...bySource].map(async ([from, threadRefs]) => {
      const triggers = { threadRefs, from, to };
      await Promise.all([deps.crons.rehome(triggers), deps.webhooks.rehome(triggers), deps.monitors?.rehome(triggers)]);
      if (loops)
        await Promise.all(
          (await loops.ownedBy(from))
            .filter((loop) => postsInto(loop, threadRefs))
            .map((loop) => loops.update(loop.id, { destination: null })),
        );
    }),
  );
  const sessions = trees.flat();
  const isolations = sessions.flatMap((s) => s.spawnMeta?.isolation ?? []);
  const own = new Set(isolations.flatMap((i) => (i.mode === "sandbox" && i.sandboxId ? [i.sandboxId] : [])));
  const bound = new Set(isolations.flatMap((i) => i.sandboxId ?? []));
  const computers = new Map([...bound].map((id) => [id, own.has(id) ? randomUUID() : null] as const));
  const spawnMeta = new Map(
    sessions.flatMap((s) => (s.spawnMeta ? [[s.id, rehomedSpawnMeta(s.spawnMeta, target, computers)] as const] : [])),
  );
  await deps.sessions.rehome(
    tenant,
    sessions.map((s) => s.id),
    { type: "group", scopeId: to, channelName: target.channelName },
    members,
    spawnMeta,
  );
}
