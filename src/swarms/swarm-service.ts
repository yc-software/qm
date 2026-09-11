import { createHash, randomUUID } from "node:crypto";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { SandboxResources } from "../sandbox/sandbox-resources.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { sleep, withTimeout } from "../util/async.ts";
import { createSweeper } from "../util/sweeper.ts";
import { errMessage, swallow } from "../util/errors.ts";
import { selectAudience } from "./audience.ts";
import { SWARM_LIMITS, type Swarm, type SwarmMember, type SwarmMessage, type SwarmStore } from "./swarm-store.ts";

export type SwarmCaller =
  { kind: "agent"; claims: CapabilityClaims } | { kind: "human"; actorId: string; sessionId: string; runId?: string };

export interface SwarmTurn {
  swarmId: string;
  messageId: string;
  recipientId: string;
}

interface SpawnInput {
  requestId: string;
  count?: number;
  context?: unknown;
  contexts?: unknown[];
  text: string;
  forumSandboxId?: string;
}

interface MessageInput {
  requestId: string;
  audience: string;
  text: string;
  replyTo?: string;
  notify?: boolean;
}

interface Authority {
  sessionId: string;
  actorId: string;
  rootId: string;
  memberId: string;
}

export interface SwarmService {
  start(): void;
  stop(): void;
  sweep(): Promise<void>;
  inspect(
    caller: SwarmCaller,
  ): Promise<{ id: string; self: SwarmMember; peers: SwarmMember[]; limits: typeof SWARM_LIMITS; expiresAt: number }>;
  context(caller: SwarmCaller, context: unknown): Promise<SwarmMember>;
  spawn(caller: SwarmCaller, input: SpawnInput): Promise<SwarmMember[]>;
  send(caller: SwarmCaller, input: MessageInput): Promise<SwarmMessage>;
  read(caller: SwarmCaller, options: { after?: number; replyTo?: string; waitMs?: number }): Promise<SwarmMessage[]>;
  binding(input: OrchestratorInput): Promise<{ sandboxId?: string; rootSessionId: string; member: SwarmMember } | null>;
}

function boundedText(value: string, max: number, name: string): void {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) throw new Error(`invalid ${name}`);
}

function jsonContext(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > SWARM_LIMITS.contextBytes)
    throw new Error("invalid context");
  return JSON.parse(encoded) as unknown;
}

function signature(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const RUN_EXECUTION_FIELDS = new Set([
  "runId",
  "attempt",
  "finalAttempt",
  "background",
  "cancel",
  "queueMs",
  "runStartedAt",
]);

function requestSignature(input: OrchestratorInput): string {
  return signature(Object.fromEntries(Object.entries(input).filter(([key]) => !RUN_EXECUTION_FIELDS.has(key))));
}

function threadIdentity(threadRef: string, sessionId: string): { rootId: string; memberId: string } {
  if (!threadRef.startsWith("swarm:")) return { rootId: sessionId, memberId: sessionId };
  const parts = threadRef.split(":");
  if (parts.length !== 3 || !parts[1] || !parts[2]) throw new Error("invalid swarm session");
  return { rootId: decodeURIComponent(parts[1]), memberId: parts[2] };
}

function assertOpen(swarm: Swarm): void {
  if (Date.now() >= swarm.expiresAt) throw new Error("swarm work window expired");
}

export function createSwarmService(deps: {
  store: SwarmStore;
  sessions: SessionStore;
  runs: RunStore;
  sandboxes: SandboxResources;
  lock: AdvisoryLock;
  authorize(claims: Pick<CapabilityClaims, "actorId" | "scopeId" | "scopeVersion" | "members">): Promise<boolean>;
}): SwarmService {
  const { store, sessions, runs } = deps;
  const view = (member: SwarmMember): SwarmMember => ({
    ...member,
    ...(member.sessionId ? { sessionUrl: `/web-ui/s/${encodeURIComponent(member.sessionId)}` } : {}),
  });

  async function authority(caller: SwarmCaller): Promise<Authority> {
    const actorId = caller.kind === "agent" ? caller.claims.actorId : caller.actorId;
    const session =
      caller.kind === "agent"
        ? await sessions.getByThread(caller.claims.threadRef ?? "")
        : await sessions.get(caller.sessionId);
    if (!session) throw new Error("session not found");
    const participants = await sessions.participantsOf(session.id);
    if (!participants.includes(actorId)) throw new Error("session access denied");
    if (caller.kind === "agent") {
      if (caller.claims.scopeId !== session.scopeId || !caller.claims.runId)
        throw new Error("session-bound capability required");
      const run = await runs.get(caller.claims.runId);
      if (
        !run ||
        run.sessionId !== session.threadRef ||
        run.request.conversation.threadRef !== session.threadRef ||
        run.request.actor.id !== actorId ||
        conversationScope(run.request.conversation, actorId) !== session.scopeId
      )
        throw new Error("capability run mismatch");
      if (run.status !== "running" || !run.leaseToken || !run.leaseExpiresAt || run.leaseExpiresAt <= Date.now())
        throw new Error("active capability run required");
    }
    const identity = threadIdentity(session.threadRef, session.id);
    const swarm = await store.get(identity.rootId);
    if (
      !(await deps.authorize({
        actorId,
        scopeId: session.scopeId,
        ...(swarm?.template.scopeVersion ? { scopeVersion: swarm.template.scopeVersion } : {}),
        ...(caller.kind === "agent" && caller.claims.members ? { members: caller.claims.members } : {}),
      }))
    )
      throw new Error("scope access denied");
    if (swarm) {
      if (swarm.scopeId !== session.scopeId || !swarm.participants.includes(actorId))
        throw new Error("swarm access denied");
      const rootParticipants = (await sessions.participantsOf(swarm.id)).sort();
      if (signature(rootParticipants) !== signature([...swarm.participants].sort()))
        throw new Error("swarm roster changed");
      if (signature([...participants].sort()) !== signature([...swarm.participants].sort()))
        throw new Error("swarm session roster changed");
      if (!swarm.members.some((member) => member.id === identity.memberId && member.sessionId === session.id))
        throw new Error("session is not a swarm member");
    } else if (identity.rootId !== session.id) throw new Error("swarm not found");
    return { ...identity, sessionId: session.id, actorId };
  }

  async function load(caller: SwarmCaller): Promise<{ auth: Authority; swarm: Swarm; self: SwarmMember }> {
    const auth = await authority(caller);
    const swarm = await store.get(auth.rootId);
    const self = swarm?.members.find((member) => member.id === auth.memberId);
    if (!swarm || !self) throw new Error("swarm not found; spawn an initial pool first");
    return { auth, swarm, self };
  }

  async function initialize(caller: SwarmCaller, auth: Authority): Promise<Swarm> {
    const existing = await store.get(auth.rootId);
    if (existing) return existing;
    const runId = caller.kind === "agent" ? caller.claims.runId : caller.runId;
    const run = runId ? await runs.get(runId) : null;
    const session = await sessions.get(auth.sessionId);
    if (
      !run ||
      !session ||
      run.request.conversation.threadRef !== session.threadRef ||
      run.request.actor.id !== auth.actorId
    )
      throw new Error("a run belonging to this session is required to initialize a swarm");
    if (conversationScope(run.request.conversation, auth.actorId) !== session.scopeId)
      throw new Error("run scope mismatch");
    const source = run.request;
    const template: OrchestratorInput = {
      actor: source.actor,
      conversation: {
        ...source.conversation,
        channelRef:
          source.conversation.channelRef ??
          (source.conversation.kind === "dm" ? undefined : source.conversation.threadRef),
      },
      origin: { kind: "automation" },
      surface: "swarm",
      text: "",
      ...(source.scopeVersion ? { scopeVersion: source.scopeVersion } : {}),
      ...(source.unattendedGrants ? { unattendedGrants: source.unattendedGrants } : {}),
      ...(source.readOnly ? { readOnly: true } : {}),
      ...(source.skipMemory ? { skipMemory: true } : {}),
      ...(source.harness ? { harness: source.harness } : {}),
      ...(source.model ? { model: source.model } : {}),
      turnWallClockMs: SWARM_LIMITS.turnMs,
    };
    return store.create({
      id: session.id,
      scopeId: session.scopeId,
      ownerId: auth.actorId,
      participants: await sessions.participantsOf(session.id),
      template,
      createdAt: Date.now(),
      expiresAt: Date.now() + SWARM_LIMITS.lifetimeMs,
      members: [
        {
          id: session.id,
          sessionId: session.id,
          threadRef: session.threadRef,
          depth: 0,
          context: {},
          state: "ready",
          attempts: 0,
        },
      ],
      messages: [],
      spawnRequests: {},
      messageRequests: {},
      notificationCount: 0,
      pending: false,
    });
  }

  async function reserveMessage(
    rootId: string,
    auth: Authority,
    author: SwarmCaller["kind"],
    input: MessageInput,
    audience: string[],
  ): Promise<SwarmMessage> {
    const key = signature([auth.memberId, auth.actorId, author, input.requestId]);
    const fingerprint = signature(input);
    const id = randomUUID();
    const updated = await store.update(rootId, (swarm) => {
      const previous = swarm.messageRequests[key];
      if (previous) {
        if (previous.signature !== fingerprint) throw new Error("requestId reused with different content");
        return;
      }
      assertOpen(swarm);
      if (swarm.messages.length >= SWARM_LIMITS.messages) throw new Error("swarm message budget exhausted");
      if (input.replyTo && !swarm.messages.some((message) => message.id === input.replyTo))
        throw new Error("reply target is not in this swarm");
      const recipients = input.notify === false ? [] : audience.filter((peer) => peer !== auth.memberId);
      if (swarm.notificationCount + recipients.length > SWARM_LIMITS.notifications)
        throw new Error("swarm notification budget exhausted");
      swarm.notificationCount += recipients.length;
      swarm.messages.push({
        id,
        seq: swarm.messages.length + 1,
        senderId: auth.memberId,
        senderSessionId: auth.sessionId,
        author,
        actorId: auth.actorId,
        text: input.text,
        audience,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        createdAt: Date.now(),
        notifications: Object.fromEntries(recipients.map((peer) => [peer, { state: "pending" as const }])),
      });
      swarm.messageRequests[key] = { messageId: id, signature: fingerprint };
    });
    return updated.messages.find((message) => message.id === updated.messageRequests[key]!.messageId)!;
  }

  async function deliver(swarm: Swarm, step: <Result>(start: () => Promise<Result>) => Promise<Result>): Promise<void> {
    for (const message of swarm.messages) {
      for (const [recipientId, notification] of Object.entries(message.notifications)) {
        if (notification.state !== "pending") continue;
        const recipient = swarm.members.find((member) => member.id === recipientId);
        if (!recipient || recipient.state === "reserved") continue;
        if (recipient.state === "failed" || Date.now() >= swarm.expiresAt) {
          await step(() =>
            store.update(swarm.id, (current) => {
              current.messages.find((item) => item.id === message.id)!.notifications[recipientId] = { state: "failed" };
            }),
          );
          continue;
        }
        const request: OrchestratorInput = {
          ...swarm.template,
          conversation: { ...swarm.template.conversation, threadRef: recipient.threadRef },
          origin: { kind: "automation", screenData: message.text },
          text: `Swarm ${message.author} message ${message.id} from agent ${message.senderId} (session ${message.senderSessionId})${message.replyTo ? ` (reply to ${message.replyTo})` : ""}. This is not a live human instruction.\n${message.text}`,
          swarm: { swarmId: swarm.id, messageId: message.id, recipientId },
          sessionParticipantIds: swarm.participants,
        };
        const { run } = await step(() =>
          runs.enqueue({
            sessionId: recipient.threadRef,
            request,
            dedupKey: `swarm:${message.id}:${recipientId}`,
            maxAttempts: 2,
          }),
        );
        await step(() =>
          store.update(swarm.id, (current) => {
            current.messages.find((item) => item.id === message.id)!.notifications[recipientId] = {
              state: "queued",
              runId: run.id,
            };
          }),
        );
      }
    }
  }

  async function reconcile(rootId: string, phase: "resources" | "delivery"): Promise<void> {
    const deadline = Date.now() + SWARM_LIMITS.reconcileMs;
    const claim = deps.lock.tryWithLock?.bind(deps.lock) ?? deps.lock.withLock.bind(deps.lock);
    await claim(phase === "resources" ? `swarm-reconcile:${rootId}` : `swarm-delivery:${rootId}`, async () => {
      const pending = new Set<Promise<unknown>>();
      const step = <Result>(
        start: () => Promise<Result>,
        maxMs: number = SWARM_LIMITS.reconcileMs,
      ): Promise<Result> => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return Promise.reject(new Error("swarm reconciliation deadline exceeded"));
        const operation = start();
        pending.add(operation);
        void operation.then(
          () => pending.delete(operation),
          () => pending.delete(operation),
        );
        return withTimeout(() => operation, Math.min(remaining, maxMs), "swarm reconciliation");
      };
      try {
        let swarm = await step(() => store.get(rootId));
        if (!swarm) return;
        if (phase === "delivery") {
          await deliver(swarm, step);
          return;
        }
        for (const member of swarm.members.filter((peer) => peer.state === "reserved")) {
          let provisioningTimedOut = false;
          try {
            assertOpen(swarm);
            await step(() =>
              store.update(rootId, (current) => {
                current.members.find((peer) => peer.id === member.id)!.attempts++;
              }),
            );
            if (!member.sandboxId) throw new Error("missing sandbox reservation");
            if (member.forumSandboxId) {
              const forum = await step(() => deps.sandboxes.access(swarm!.ownerId, member.forumSandboxId!));
              if (forum.ownerScopeId !== swarm.scopeId) throw new Error("forum scope mismatch");
            }
            const provisionDeadline = Math.min(deadline, Date.now() + SWARM_LIMITS.provisionMs);
            await step(
              () => deps.sandboxes.create(swarm!.ownerId, swarm!.scopeId, "modal", "Swarm worker", member.id),
              SWARM_LIMITS.provisionMs,
            ).catch((error: unknown) => {
              provisioningTimedOut = Date.now() >= provisionDeadline;
              throw error;
            });
            const session = await step(() =>
              sessions.getOrCreateByThread(
                member.threadRef,
                swarm!.template.conversation.kind,
                swarm!.scopeId,
                undefined,
                "swarm",
              ),
            );
            await Promise.all(
              swarm.participants.map((principalId) => step(() => sessions.addParticipant(session.id, principalId))),
            );
            await step(() => sessions.updateTitle(session.id, `Swarm worker ${member.id.slice(0, 8)}`));
            await step(() =>
              store.update(rootId, (current) => {
                if (Date.now() >= deadline) throw new Error("swarm reconciliation deadline exceeded");
                assertOpen(current);
                Object.assign(
                  current.members.find((peer) => peer.id === member.id)!,
                  { state: "ready", sessionId: session.id },
                );
              }),
            );
          } catch (error) {
            await store.update(rootId, (current) => {
              const failed = current.members.find((peer) => peer.id === member.id)!;
              if (failed.state !== "reserved") return;
              failed.error = errMessage(error).slice(0, 500);
              if (
                provisioningTimedOut ||
                Date.now() >= deadline ||
                failed.attempts >= 3 ||
                Date.now() >= current.expiresAt
              ) {
                failed.state = "failed";
                failed.cleanupPending = true;
              }
            });
            if (pending.size || Date.now() >= deadline) return;
          }
        }
        if (pending.size) return;
        swarm = await step(() => store.get(rootId));
        for (const member of swarm?.members.filter((peer) => peer.cleanupPending) ?? []) {
          const session = await step(() => sessions.getByThread(member.threadRef));
          if (session && !(await step(() => sessions.deleteSessionIfEmpty(session.id)))) continue;
          if (member.sandboxId === member.id) {
            const inventory = await step(() => deps.sandboxes.list(swarm!.ownerId, swarm!.scopeId));
            const resource = inventory.sandboxes.find((resource) => resource.id === member.id);
            if (resource) await step(() => deps.sandboxes.retire(swarm!.ownerId, member.id));
          }
          await step(() =>
            store.update(rootId, (current) => {
              current.members.find((peer) => peer.id === member.id)!.cleanupPending = false;
            }),
          );
        }
      } finally {
        await Promise.allSettled(pending);
      }
    });
  }

  let sweeping: Promise<void> | undefined;
  let selecting: Promise<Swarm[]> | undefined;
  let afterId: string | undefined;
  const reconciling = {
    resources: new Map<string, Promise<void>>(),
    delivery: new Map<string, Promise<void>>(),
  };
  async function reconcileBatch(batch: Swarm[], phase: keyof typeof reconciling): Promise<void> {
    const active = reconciling[phase];
    const remaining = batch.values();
    await Promise.all(
      Array.from({ length: Math.min(batch.length, SWARM_LIMITS.sweepConcurrency - active.size) }, async () => {
        for (const swarm of remaining) {
          if (active.has(swarm.id)) continue;
          if (
            phase === "resources" &&
            !swarm.members.some((member) => member.state === "reserved" || member.cleanupPending)
          )
            continue;
          if (active.size >= SWARM_LIMITS.sweepConcurrency) return;
          const operation = reconcile(swarm.id, phase)
            .catch((error) => swallow("swarm outbox reconciliation", error))
            .finally(() => {
              active.delete(swarm.id);
            });
          active.set(swarm.id, operation);
          await withTimeout(() => operation, SWARM_LIMITS.reconcileMs, "swarm reconciliation").catch((error) =>
            swallow("swarm outbox reconciliation", error),
          );
        }
      }),
    );
  }
  const sweep = (): Promise<void> => {
    sweeping ??= (async () => {
      selecting ??= store.pending(afterId).finally(() => {
        selecting = undefined;
      });
      const batch = await withTimeout(() => selecting!, SWARM_LIMITS.reconcileMs, "swarm pending batch");
      afterId = batch.length === SWARM_LIMITS.sweepBatch ? batch.at(-1)!.id : undefined;
      await reconcileBatch(batch, "resources");
      await reconcileBatch(batch, "delivery");
    })().finally(() => {
      sweeping = undefined;
    });
    return sweeping;
  };
  const sweeper = createSweeper(sweep, 2_000, { label: "swarm-outbox", immediate: true });

  return {
    ...sweeper,
    sweep,
    async inspect(caller) {
      const { swarm, self } = await load(caller);
      return {
        id: swarm.id,
        self: view(self),
        peers: swarm.members.map(view),
        limits: SWARM_LIMITS,
        expiresAt: swarm.expiresAt,
      };
    },
    async context(caller, context) {
      const value = jsonContext(context);
      const { auth } = await load(caller);
      const updated = await store.update(auth.rootId, (swarm) => {
        assertOpen(swarm);
        swarm.members.find((member) => member.id === auth.memberId)!.context = value;
      });
      return view(updated.members.find((member) => member.id === auth.memberId)!);
    },
    async spawn(caller, input) {
      boundedText(input.requestId, 128, "requestId");
      boundedText(input.text, SWARM_LIMITS.textBytes, "text");
      const count = input.count ?? input.contexts?.length ?? 1;
      if (!Number.isInteger(count) || count < 1 || count >= SWARM_LIMITS.agents) throw new Error("invalid pool size");
      if (input.contexts && input.contexts.length !== count) throw new Error("contexts must match count");
      const defaultContext = "context" in input ? input.context : {};
      const contexts = Array.from({ length: count }, (_value, index) =>
        jsonContext(input.contexts ? input.contexts[index] : defaultContext),
      );
      const auth = await authority(caller);
      const existing = await initialize(caller, auth);
      const key = signature([auth.memberId, auth.actorId, caller.kind, input.requestId]);
      const fingerprint = signature(input);
      const previous = existing.spawnRequests[key];
      if (previous) {
        if (previous.signature !== fingerprint) throw new Error("requestId reused with different content");
        return existing.members.filter((member) => previous.memberIds.includes(member.id)).map(view);
      }
      if (input.forumSandboxId) {
        const forum = await deps.sandboxes.access(auth.actorId, input.forumSandboxId);
        const swarm = await store.get(auth.rootId);
        if (forum.ownerScopeId !== swarm!.scopeId) throw new Error("forum scope mismatch");
      }
      const updated = await store.update(auth.rootId, (swarm) => {
        const previous = swarm.spawnRequests[key];
        if (previous) {
          if (previous.signature !== fingerprint) throw new Error("requestId reused with different content");
          return;
        }
        assertOpen(swarm);
        const parent = swarm.members.find((member) => member.id === auth.memberId)!;
        if (parent.depth >= SWARM_LIMITS.depth) throw new Error("swarm depth budget exhausted");
        if (swarm.members.length + count > SWARM_LIMITS.agents) throw new Error("swarm agent budget exhausted");
        if (Object.keys(swarm.spawnRequests).length >= SWARM_LIMITS.spawnRequests)
          throw new Error("swarm spawn budget exhausted");
        if (
          swarm.messages.length >= SWARM_LIMITS.messages ||
          swarm.notificationCount + count > SWARM_LIMITS.notifications
        )
          throw new Error("swarm work budget exhausted");
        const members: SwarmMember[] = contexts.map((context) => {
          const id = randomUUID();
          return {
            id,
            parentId: parent.id,
            threadRef: `swarm:${encodeURIComponent(swarm.id)}:${id}`,
            depth: parent.depth + 1,
            context,
            sandboxId: id,
            ...(input.forumSandboxId ? { forumSandboxId: input.forumSandboxId } : {}),
            state: "reserved",
            attempts: 0,
          };
        });
        swarm.members.push(...members);
        swarm.spawnRequests[key] = { memberIds: members.map((member) => member.id), signature: fingerprint };
        swarm.messages.push({
          id: randomUUID(),
          seq: swarm.messages.length + 1,
          senderId: parent.id,
          senderSessionId: auth.sessionId,
          author: caller.kind,
          actorId: auth.actorId,
          text: input.text,
          audience: members.map((member) => member.id),
          createdAt: Date.now(),
          notifications: Object.fromEntries(members.map((member) => [member.id, { state: "pending" as const }])),
        });
        swarm.notificationCount += count;
      });
      const ids = updated.spawnRequests[key]!.memberIds;
      return updated.members.filter((member) => ids.includes(member.id)).map(view);
    },
    async send(caller, input) {
      boundedText(input.requestId, 128, "requestId");
      boundedText(input.text, SWARM_LIMITS.textBytes, "text");
      const { auth, swarm } = await load(caller);
      const previous = swarm.messageRequests[signature([auth.memberId, auth.actorId, caller.kind, input.requestId])];
      if (previous) {
        if (previous.signature !== signature(input)) throw new Error("requestId reused with different content");
        return swarm.messages.find((message) => message.id === previous.messageId)!;
      }
      const eligible: SwarmMember[] = [];
      for (const member of swarm.members) {
        if (member.state !== "ready" || !member.sessionId) continue;
        const session = await sessions.get(member.sessionId);
        const participants = await sessions.participantsOf(member.sessionId);
        if (
          session?.scopeId === swarm.scopeId &&
          signature([...participants].sort()) === signature([...swarm.participants].sort())
        )
          eligible.push(member);
      }
      const audience = await selectAudience(input.audience, eligible);
      return reserveMessage(swarm.id, auth, caller.kind, input, audience);
    },
    async read(caller, options) {
      const waitMs = options.waitMs ?? 0;
      const after = options.after ?? 0;
      if (
        !Number.isInteger(waitMs) ||
        waitMs < 0 ||
        waitMs > SWARM_LIMITS.waitMs ||
        !Number.isInteger(after) ||
        after < 0
      )
        throw new Error("invalid read bounds");
      const deadline = Date.now() + waitMs;
      for (;;) {
        const { swarm } = await load(caller);
        const messages = swarm.messages
          .filter((message) => message.seq > after && (!options.replyTo || message.replyTo === options.replyTo))
          .slice(0, 32);
        if (messages.length || Date.now() >= deadline) return messages;
        await sleep(Math.min(200, deadline - Date.now()));
      }
    },
    async binding(input) {
      const session = await sessions.getByThread(input.conversation.threadRef);
      if (!session) {
        if (input.swarm || input.conversation.threadRef.startsWith("swarm:")) throw new Error("unknown swarm session");
        return null;
      }
      const identity = threadIdentity(session.threadRef, session.id);
      if (!input.swarm && identity.rootId === session.id) return null;
      const swarm = await store.get(identity.rootId);
      if (!swarm) {
        if (input.swarm || session.threadRef.startsWith("swarm:")) throw new Error("unknown swarm");
        return null;
      }
      const member = swarm.members.find((peer) => peer.id === identity.memberId);
      if (!member || member.state !== "ready" || member.sessionId !== session.id || session.scopeId !== swarm.scopeId)
        throw new Error("invalid swarm membership");
      if (!input.swarm) {
        if (
          !(await sessions.participantsOf(session.id)).includes(input.actor.id) ||
          conversationScope(input.conversation, input.actor.id) !== session.scopeId ||
          !(await deps.authorize({
            actorId: input.actor.id,
            scopeId: session.scopeId,
            scopeVersion: input.scopeVersion,
            members: input.conversation.audience,
          }))
        )
          throw new Error("swarm session access denied");
        return { sandboxId: member.sandboxId, rootSessionId: swarm.id, member };
      }
      if (input.swarm) {
        assertOpen(swarm);
        const message = swarm.messages.find((item) => item.id === input.swarm!.messageId);
        const dedup = message ? await runs.getByDedupKey(`swarm:${message.id}:${member.id}`) : null;
        if (
          input.swarm.swarmId !== swarm.id ||
          input.swarm.recipientId !== member.id ||
          !message?.audience.includes(member.id) ||
          !dedup ||
          dedup.id !== input.runId ||
          input.origin.kind !== "automation" ||
          input.actor.id !== swarm.ownerId ||
          input.surface !== "swarm" ||
          input.deliveryTarget ||
          input.surfaceTools ||
          input.origin.useOwnerKeychain ||
          requestSignature(input) !== requestSignature(dedup.request)
        )
          throw new Error("forged swarm provenance");
      }
      const participants = await sessions.participantsOf(swarm.id);
      const recipientParticipants = await sessions.participantsOf(session.id);
      if (
        signature([...participants].sort()) !== signature([...swarm.participants].sort()) ||
        signature([...recipientParticipants].sort()) !== signature([...swarm.participants].sort()) ||
        !swarm.participants.includes(input.actor.id) ||
        conversationScope(input.conversation, input.actor.id) !== swarm.scopeId ||
        !(await deps.authorize({
          actorId: input.actor.id,
          scopeId: swarm.scopeId,
          scopeVersion: swarm.template.scopeVersion,
          members: input.conversation.audience,
        }))
      )
        throw new Error("swarm authorization changed");
      return { sandboxId: member.sandboxId, rootSessionId: swarm.id, member };
    },
  };
}
