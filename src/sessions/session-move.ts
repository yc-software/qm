import { randomUUID } from "node:crypto";
import type { CronStore } from "../cron/cron-store.ts";
import type { LoopStore } from "../loops/loop-store.ts";
import type { MonitorStore } from "../monitors/monitor-store.ts";
import type { ProcessRecord, ProcessRegistry } from "../processes/process-registry.ts";
import { reconcileProcesses } from "../processes/reconcile.ts";
import { supportsProcessSessions, type Sandbox } from "../sandbox/sandbox.ts";
import type { Tenant } from "../tenants/context.ts";
import {
  parseScopeId,
  scopeId,
  type ChildIsolation,
  type Principal,
  type ScopeId,
  type Session,
  type SpawnMeta,
} from "../types.ts";
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
  loops?: Pick<LoopStore, "retargetMovedDestinations">;
}

export type ChatTree = readonly Session[];

export interface JobHold {
  purpose: string;
  chat?: string;
}

interface StoppedLoop {
  name: string;
  chat: string;
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

async function liveJobs(deps: ChatMoveDeps, tenant: Tenant, trees: readonly ChatTree[]) {
  return (
    deps.processes?.runningJobsIn(
      tenant,
      [...new Set(trees.map((tree) => tree[0]!.scopeId))],
      trees.flatMap((tree) => tree.map((s) => s.threadRef)),
    ) ?? []
  );
}

export async function settleChatJobs(
  deps: ChatMoveDeps,
  tenant: Tenant,
  trees: readonly ChatTree[],
): Promise<ProcessRecord[]> {
  const jobs = await liveJobs(deps, tenant, trees);
  const { processes, sandbox } = deps;
  if (!jobs.length || !processes || !sandbox || !supportsProcessSessions(sandbox)) return jobs;
  const hosts = new Map(jobs.flatMap((rec) => (rec.sandboxId ? [[rec.sandboxId, rec.scopeId]] : [])));
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
  return liveJobs(deps, tenant, trees);
}

export function runningJob(tree: ChatTree, jobs: readonly ProcessRecord[]): JobHold | undefined {
  const job = jobs.find((rec) => tree.some((s) => s.threadRef === rec.sessionRef));
  if (!job) return undefined;
  const chat = tree.find((s) => s.threadRef === job.sessionRef);
  return {
    purpose: job.purpose ?? job.command.replace(/^bg: /, ""),
    ...(chat && chat !== tree[0] && chat.title ? { chat: chat.title } : {}),
  };
}

export function busyHold(
  tree: ChatTree,
  active: { has(threadRef: string): boolean },
): { subagent?: { title?: string } } | undefined {
  if (active.has(tree[0]!.threadRef)) return {};
  const child = tree.find((s) => active.has(s.threadRef));
  if (!child) return undefined;
  return { subagent: child.title ? { title: child.title } : {} };
}

export function moveConfirmation(titles: readonly string[], project: string, readers: readonly string[]): string {
  const list = readers.length > 1 ? `${readers.slice(0, -1).join(", ")} and ${readers.at(-1)}` : (readers[0] ?? "");
  const one = titles.length === 1;
  const what = one ? `"${titles[0]}"` : `${titles.length} chats`;
  return `Move ${what} to ${project}? ${list} will be able to read ${one ? "it" : "them"}, including ${one ? "its" : "their"} earlier messages.`;
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
  mover: string,
  sourceMembers: ReadonlyMap<ScopeId, readonly string[]>,
): Promise<StoppedLoop[]> {
  const threads = new Map(trees.flatMap((tree) => tree.map((s) => [s.threadRef, tree[0]!.scopeId] as const)));
  const move = { threads, to };
  const loopOwners = [
    ...threads.values(),
    ...[...sourceMembers.values()].flat().map((member) => scopeId("personal", member)),
  ];

  const [, , , stopped = []] = await Promise.all([
    deps.crons.rehome(move),
    deps.webhooks.rehome(move),
    deps.monitors?.rehome(move),
    deps.loops?.retargetMovedDestinations(move, members, loopOwners),
  ]);
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
    {
      principalId: mover,
      sessionIds: trees.flatMap((tree) =>
        parseScopeId(tree[0]!.scopeId).kind === "personal" ? tree.map((s) => s.id) : [],
      ),
    },
  );
  const chatOf = new Map(trees.flatMap((tree) => tree.map((s) => [s.threadRef, tree[0]!] as const)));
  return stopped.map((loop) => ({
    name: loop.name,
    chat: chatOf.get(loop.destination!.target)?.title ?? "Untitled chat",
  }));
}
