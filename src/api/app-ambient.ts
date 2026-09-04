import type { ActorAssertion, TurnRequest } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";
import { samePerson } from "../directory/person.ts";
import type { DirectoryMember } from "../directory/directory-store.ts";
import type { CachedMessage } from "../surface-cache/surface-cache.ts";
import { DEFAULT_ROLLUP_HOURS, type BotPolicy } from "../surface-cache/channel-policy-store.ts";
import {
  judgeAmbientBatch,
  renderAmbientPrompt,
  type AmbientBatch,
  type AmbientDecision,
} from "../surface-cache/ambient-judge.ts";
import type { AmbientJudgmentStore } from "../surface-cache/ambient-judgment-store.ts";
import { errMessage } from "../util/errors.ts";
import { buildWakeEnvelope } from "../core/wake-envelope.ts";
import { isTerminal } from "../runs/run-store.ts";
import { unscreenedNotice } from "../security/security-posture.ts";
import { swallow, swallowAs } from "../util/errors.ts";

import type { App, AppDeps } from "./app-types.ts";

export function createAmbientHelpers(deps: AppDeps, app: App) {
  function shouldRouteToSpine(input: OrchestratorInput): boolean {
    const { conversation } = input;
    return conversation.kind !== "dm" && (input.origin.kind === "human" || input.origin.kind === "ambient");
  }

  function markTriggerHandled(input: OrchestratorInput): void {
    if (input.origin.kind !== "human" || !input.origin.messageTs) return;
    const container = input.conversation.channelRef ?? input.conversation.threadRef;
    void deps.surfaceCache
      ?.markHandled(container, input.origin.messageTs)
      .catch((e) => swallow("ambient: mark handled", e));
  }

  const ambientSelf = new Map<string, { name?: string; mentionId?: string }>();
  const recordJudgment = (j: Parameters<AmbientJudgmentStore["record"]>[0]): void => {
    void deps.ambientJudgments
      ?.record(j)
      .catch((e) => console.error("[ambient] record judgment failed:", errMessage(e)));
  };
  async function judgeAmbientContainer(
    surface: string,
    container: string,
    opts?: { reason?: "messages" | "scheduled" },
  ): Promise<AmbientDecision> {
    if (!deps.surfaceCache || !deps.ambientJudge) return { act: false };
    const scheduled = opts?.reason === "scheduled";
    const policy = await deps.channelPolicy?.get(container);
    const cursorKey = `${orgIdOf()}:${surface}:${container}`;
    const cursor = deps.ambientCursors ? await deps.ambientCursors.get(cursorKey) : null;
    const after = cursor?.lastJudgedTs;
    const all = await deps.surfaceCache.readMessages(container, { limit: 60, noFallback: true });
    const backdrop = after ? all.filter((m) => m.ts <= after).slice(-10) : [];
    const rawDelta = (after ? all.filter((m) => m.ts > after) : all).filter((m) => !m.self);
    const ledger = new Map<string, BotPolicy>();
    for (const [name, b] of Object.entries(policy?.bots ?? {})) ledger.set(name.toLowerCase(), b);
    const botModeOf = (m: CachedMessage): BotPolicy["mode"] | undefined =>
      m.bot && m.authorName ? ledger.get(m.authorName.toLowerCase())?.mode : undefined;
    const delta = rawDelta
      .filter((m) => !m.handled)
      .filter((m) => botModeOf(m) !== "ignore")
      .map((m) => (botModeOf(m) === "user" ? { ...m, bot: false } : m));
    const rawLatestTs = rawDelta.reduce((max, m) => (m.ts > max ? m.ts : max), after ?? "");
    const advanceCursor = async (): Promise<void> => {
      if (deps.ambientCursors && rawDelta.length && rawLatestTs)
        await deps.ambientCursors
          .put(cursorKey, { lastJudgedTs: rawLatestTs, lastJudgedAt: Date.now() })
          .catch(() => undefined);
    };
    if (!delta.length && !scheduled) {
      await advanceCursor();
      return { act: false };
    }
    if (!scheduled && delta.length && delta.every((m) => botModeOf(m) === "rollup")) {
      const lastAt = cursor?.lastJudgedAt;
      const held =
        lastAt !== undefined &&
        delta.every((m) => {
          const hours = ledger.get((m.authorName ?? "").toLowerCase())?.rollupHours ?? DEFAULT_ROLLUP_HOURS;
          return Date.now() - lastAt < hours * 3_600_000;
        });
      if (held) return { act: false };
    }
    const tsFrom = delta.reduce((min, m) => (min === "" || m.ts < min ? m.ts : min), "");
    const tsTo = delta.reduce((max, m) => (m.ts > max ? m.ts : max), "");
    const watchReason =
      (policy?.orders ?? "").trim().length > 0 || Object.values(policy?.bots ?? {}).some((b) => b.mode === "action");
    let ambientOffReason: string | null = null;
    if ((await deps.config?.getOrgAmbientDurable()) === false) {
      ambientOffReason = "ambient is switched off org-wide";
    } else if (policy?.ambientEnabled === false) {
      ambientOffReason = "ambient is switched off for this channel";
    } else if (policy?.ambientEnabled === undefined && !watchReason) {
      ambientOffReason =
        "ambient defaults off — no standing orders or action-bot triggers here, so only @mentions engage";
    }
    if (ambientOffReason) {
      recordJudgment({
        surface,
        container,
        decision: "ignore",
        reason: ambientOffReason,
        ...(tsFrom ? { tsFrom } : {}),
        ...(tsTo ? { tsTo } : {}),
        createdAt: Date.now(),
      });
      await advanceCursor();
      return { act: false };
    }
    const self = ambientSelf.get(`${orgIdOf()}:${surface}`);
    const forJudge = delta.filter((m) => !m.mentionsSelf);
    if (forJudge.length < delta.length)
      recordJudgment({
        surface,
        container,
        decision: "fastlane",
        ...(tsFrom ? { tsFrom } : {}),
        ...(tsTo ? { tsTo } : {}),
        createdAt: Date.now(),
      });
    const actionBots = [
      ...new Set(
        delta
          .filter((m) => botModeOf(m) === "action")
          .map((m) => m.authorName ?? "")
          .filter(Boolean),
      ),
    ];
    const actionLines = actionBots.map((n) => `Posts from bot "${n}" are triggers you should act on.`);
    const ordersForJudge = actionLines.length
      ? [actionLines.join("\n"), policy?.orders ?? ""].filter((s) => s.trim()).join("\n")
      : (policy?.orders ?? "");
    let decision: AmbientDecision = { act: false };
    if (forJudge.length || scheduled) {
      const containerKind = (await deps.surfaceCache.containerState(container).catch(() => null))?.kind;
      const judgeBatch: AmbientBatch = {
        container,
        surface,
        ...(containerKind ? { kind: containerKind } : {}),
        orders: ordersForJudge,
        ...(self ? { self } : {}),
        messages: forJudge,
        ...(backdrop.length ? { backdrop } : {}),
        ...(scheduled ? { scheduled: true } : {}),
      };
      const prompt = renderAmbientPrompt(judgeBatch);
      const startedAt = Date.now();
      const judgeModel = deps.judgeModelId?.();
      const botTs = new Set(rawDelta.filter((m) => m.bot).map((m) => m.ts));
      decision = await judgeAmbientBatch(
        {
          judge: deps.ambientJudge,
          spawnWorker: (b: AmbientBatch, d: AmbientDecision) =>
            spawnAmbientWorker(
              { ...b, messages: b.messages.map((m) => (botTs.has(m.ts) && !m.bot ? { ...m, bot: true } : m)) },
              d,
            ),
        },
        judgeBatch,
      ).catch(() => ({ act: false }) as AmbientDecision);
      recordJudgment({
        surface,
        container,
        decision: decision.act ? "act" : "ignore",
        ...(decision.reason ? { reason: decision.reason } : {}),
        ...(decision.askedBy ? { askedBy: decision.askedBy } : {}),
        prompt,
        ...(judgeModel ? { model: judgeModel } : {}),
        latencyMs: Date.now() - startedAt,
        ...(tsFrom ? { tsFrom } : {}),
        ...(tsTo ? { tsTo } : {}),
        createdAt: Date.now(),
      });
    }
    await advanceCursor();
    return decision;
  }

  async function solicitedAsker(
    batch: AmbientBatch,
    decision: AmbientDecision,
  ): Promise<{ message: CachedMessage; member: DirectoryMember } | undefined> {
    if (!decision.askedBy) return undefined;
    const eligible = batch.messages.filter(
      (m) => !m.deleted && !m.bot && !m.self && m.authorId && (m.text ?? "").trim(),
    );
    const asking = eligible.find((m) => m.ts === decision.askedBy);
    const newest = eligible.reduce<CachedMessage | undefined>((max, m) => (!max || m.ts > max.ts ? m : max), undefined);
    if (!asking?.authorId || asking.authorId !== newest?.authorId) return undefined;
    const authorId = asking.authorId;
    const roster = await deps.directory.list().catch(swallowAs("ambient: roster read", [] as DirectoryMember[]));
    const member = roster.find((r) => samePerson(r.principalId, authorId) || samePerson(r.slackId, authorId));
    if (!member) return undefined;
    if (batch.kind === "group") {
      const inGroup = await deps.directory.groupMember(batch.container, member.principalId).catch(() => false);
      return inGroup ? { message: asking, member } : undefined;
    }
    const isPrivate = await deps.directory.channelPrivacy(batch.container).catch(() => undefined);
    if (isPrivate === undefined) return undefined;
    if (isPrivate && !(await deps.directory.channelMember(batch.container, member.principalId).catch(() => false)))
      return undefined;
    return { message: asking, member };
  }

  function workerConversation(
    batch: AmbientBatch,
    threadRef: string,
    audience: ActorAssertion[],
  ): TurnRequest["conversation"] {
    const roster: Pick<TurnRequest["conversation"], "audience" | "publishMembers"> = audience.length
      ? { audience, publishMembers: audience }
      : { audience };
    return batch.kind === "group"
      ? { kind: "group" as const, threadRef, channelRef: batch.container, isMpim: true, ...roster }
      : { kind: "channel" as const, threadRef, channelRef: batch.container, ...roster };
  }

  async function conversationAudience(batch: AmbientBatch): Promise<ActorAssertion[] | undefined> {
    const members = await deps.directory
      .conversationMembers(batch.kind === "group" ? "group" : "channel", batch.container)
      .catch(() => undefined);
    if (!members?.length) return undefined;
    return members.map((member) => ({
      externalId: member.principalId,
      ...(member.displayName ? { displayName: member.displayName } : {}),
    }));
  }

  async function spawnAmbientWorker(batch: AmbientBatch, decision: AmbientDecision): Promise<void> {
    const latestTs = batch.messages.reduce((max, m) => (m.ts > max ? m.ts : max), "");
    const threadRef = `${batch.surface}:${batch.container}:ambient:${latestTs}`;
    let solicited = await solicitedAsker(batch, decision);
    let audience: ActorAssertion[] = [];
    if (solicited) {
      const askerId = solicited.member.principalId;
      const resolved = await conversationAudience(batch);
      if (!resolved?.some((member) => samePerson(member.externalId, askerId))) {
        console.error(`[ambient] solicited wake has no complete roster (container=${batch.container})`);
        solicited = undefined;
      } else {
        audience = resolved;
      }
    }
    const conversation = workerConversation(batch, threadRef, audience);
    if (decision.askedBy && !solicited)
      console.error(
        `[ambient] solicited wake degraded to proactive (asked_by=${decision.askedBy}, container=${batch.container})`,
      );
    const shown = batch.messages.filter((m) => !m.deleted && (m.text ?? "").trim()).slice(-4);
    const req: TurnRequest = solicited
      ? {
          surface: batch.surface,
          actor: {
            externalId: solicited.member.principalId,
            ...(solicited.member.displayName ? { displayName: solicited.member.displayName } : {}),
          },
          conversation,
          deliveryTarget: batch.container,
          text: solicited.message.text,
          liveActor: true,
          triggerTs: solicited.message.ts,
          surfaceTools: true,
          async: true,
          spawned: true,
          idempotencyKey: `ambient:${orgIdOf()}:${batch.surface}:${batch.container}:${latestTs}`,
        }
      : {
          surface: batch.surface,
          actor: { externalId: `system:ambient:${orgIdOf()}` },
          conversation,
          deliveryTarget: batch.container,
          text: buildWakeEnvelope({
            reason: "ambient",
            surface: batch.surface,
            channel: batch.container,
            at: new Date(),
            why: decision.reason ?? "The recent messages here may warrant a reply.",
            orders: batch.orders,
            recentMessages: shown,
            instructions: `You don't need to have been @mentioned. Respond with the \`${batch.surface}\` tool's \`post\` action — set \`ts\` to the triggering message id to reply in its thread, or \`broadcast: true\` to post at the channel top level — or stay silent if nothing is needed. To include an image or file, name its workspace path in \`post\`'s \`files\` (it uploads with your message, in that thread). Use \`reach\` only to send to a DIFFERENT channel or person. Use the \`read_thread\` or \`search\` action if you need more context than shown.`,
          }),
          securityScreenData: JSON.stringify({
            messages: shown.map(({ authorId, authorName, ts, text }) => ({ authorId, authorName, ts, text })),
            judgeReason: decision.reason ?? null,
          }),
          triggered: true,
          surfaceTools: true,
          async: true,
          spawned: true,
          idempotencyKey: `ambient:${orgIdOf()}:${batch.surface}:${batch.container}:${latestTs}`,
        };
    if (!solicited && (await steerIntoLiveAmbientRun(batch, latestTs, req))) return;
    await app.turn(req).catch((e) => console.error("[ambient] spawn worker failed:", errMessage(e)));
  }

  async function steerIntoLiveAmbientRun(batch: AmbientBatch, latestTs: string, req: TurnRequest): Promise<boolean> {
    if (!deps.signals) return false;
    const prefix = `${batch.surface}:${batch.container}:ambient:`;
    const activeIds = await deps.runs
      .activeSessionIds()
      .catch(swallowAs("ambient: active session ids", [] as string[]));
    const liveRef = activeIds.find((id) => id.startsWith(prefix) && id !== req.conversation.threadRef);
    if (!liveRef) return false;
    const live = await deps.runs.activeForThread(liveRef);
    if (!live || isTerminal(live.status)) return false;
    const session = await deps.sessions.getByThread(liveRef).catch(() => null);
    const decision = await deps.orchestrator
      .screenSecuritySteer({
        payload: req.text,
        actor: { id: `system:ambient:${orgIdOf()}`, type: "internal" },
        conversation:
          batch.kind === "group"
            ? { kind: "group", threadRef: liveRef, channelRef: batch.container, isMpim: true, audience: [] }
            : { kind: "channel", threadRef: liveRef, channelRef: batch.container, audience: [] },
        ...(session ? { sessionId: session.id } : {}),
      })
      .catch(() => "block" as const);
    if (decision === "block") return false;
    const steerText = decision === "unscreened" ? `${unscreenedNotice("mid-turn message")}\n${req.text}` : req.text;
    await deps.signals.send(live.id, { kind: "steer", text: steerText, ts: latestTs, request: req });
    const after = await deps.runs.get(live.id);
    if (!after || isTerminal(after.status)) await app.replayOrphanedRunSignals(live.id);
    return true;
  }

  async function addressedWakeText(input: OrchestratorInput): Promise<string> {
    const container = input.conversation.channelRef ?? input.conversation.threadRef;
    const policy = deps.channelPolicy ? await deps.channelPolicy.get(container).catch(() => undefined) : undefined;
    const orders = policy?.orders;
    const sender = input.actor.displayName?.trim() || input.actor.id;
    const surface = input.surface ?? "slack";
    return buildWakeEnvelope({
      reason: "addressed",
      surface,
      channel: container,
      at: new Date(),
      why: `${sender} addressed you directly; they expect a response.`,
      ...(orders ? { orders } : {}),
      recentMessages: [],
      addressedMessages: [
        {
          ts: input.origin.kind === "human" ? (input.origin.messageTs ?? "") : "",
          ...(input.actor.displayName ? { authorName: input.actor.displayName } : {}),
          authorId: input.actor.id,
          text: input.text,
        },
      ],
      instructions: `Act on the addressed message above. Respond with the \`${surface}\` tool's \`post\` action — set \`ts\` to the triggering message id to reply in its thread, or \`broadcast: true\` to post at the channel top level. To include an image or file, name its workspace path in \`post\`'s \`files\`. Use \`reach\` only to send to a DIFFERENT channel or person. Use the \`read_thread\` or \`search\` action if you need more context than shown.`,
    });
  }

  return { shouldRouteToSpine, markTriggerHandled, judgeAmbientContainer, addressedWakeText, ambientSelf };
}

export type AmbientHelpers = ReturnType<typeof createAmbientHelpers>;
