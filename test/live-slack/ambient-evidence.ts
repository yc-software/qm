import assert from "node:assert/strict";
import { xmlEscape } from "../../src/util/message-tag.ts";

export interface StoredSession {
  threadRef?: string;
  scopeId?: string;
  parentSessionId?: string | null;
  spawnMeta?: { actor?: { id?: string }; origin?: { kind?: string }; unprompted?: boolean };
}

export interface TranscriptItem {
  kind?: string;
  tool?: string;
  text?: string;
}

export interface AmbientEvidence {
  channelId: string;
  rootTs: string;
  marker: string;
  botUserId: string;
  baseline: readonly string[];
  sessions: ReadonlyArray<{ id: string; session: StoredSession; items: readonly TranscriptItem[] }>;
  reply: { user?: string; thread_ts?: string; text?: string } | undefined;
  errors: ReadonlyArray<{ sessionId?: string }>;
}

export interface AmbientPolicyShape {
  orders: string;
  bots: Record<string, unknown>;
  ambientEnabled: boolean | null;
}

export function newAmbientRun(e: AmbientEvidence): { parent?: string; child?: string } {
  const fresh = e.sessions.filter((s) => !e.baseline.includes(s.id));
  const parent = fresh.find((s) => s.session.threadRef === `slack:${e.channelId}:ambient:${e.rootTs}`)?.id;
  const child = parent ? fresh.find((s) => s.session.parentSessionId === parent)?.id : undefined;
  return { parent, child };
}

export function assertAmbientRoundTrip(e: AmbientEvidence): void {
  const { parent, child } = newAmbientRun(e);
  assert.ok(parent, "this post started a new ambient worker in the channel");
  assert.ok(child, "that worker opened a new helper");
  const byId = new Map(e.sessions.map((s) => [s.id, s]));
  const worker = byId.get(parent)!;
  const helper = byId.get(child)!;
  const channelActor = `system:channel:${e.channelId}`;
  assert.deepEqual(
    [worker.session.spawnMeta?.actor?.id, worker.session.spawnMeta?.unprompted, worker.session.spawnMeta?.origin?.kind],
    [channelActor, true, "automation"],
    "the worker ran unprompted as the channel",
  );
  assert.deepEqual(
    [helper.session.scopeId, helper.session.spawnMeta?.actor?.id, helper.session.spawnMeta?.unprompted],
    [`channel:${e.channelId}`, channelActor, true],
    "the helper ran in the same channel as the channel, still unprompted",
  );
  const answer = [...helper.items]
    .reverse()
    .find((i) => i.kind === "AgentMessage")
    ?.text?.trim();
  assert.ok(answer, "the helper produced a final answer");
  const returns = worker.items
    .filter((i) => i.kind === "ToolResult")
    .map((i) => i.text ?? "")
    .filter((t) => t.includes(`sessionId="${child}"`) && t.includes(`kind="final_answer"`));
  assert.equal(returns.length > 0, true, "the helper's final answer came back to the worker as its subagent wake");
  assert.equal(
    returns.some((t) => t.includes(`<content>${xmlEscape(answer)}</content>`)),
    true,
    "the returned content is the helper's own final answer",
  );
  assert.deepEqual(
    [e.reply?.user, e.reply?.thread_ts, e.reply?.text?.includes(e.marker)],
    [e.botUserId, e.rootTs, true],
    "the worker replied in the note's thread",
  );
  assert.deepEqual(
    e.errors.filter((x) => x.sessionId === parent || x.sessionId === child),
    [],
    "no refusal or error recorded for the worker or its helper",
  );
}

export function assertPolicyRestored(wanted: AmbientPolicyShape, back: Partial<AmbientPolicyShape> | undefined): void {
  assert.deepEqual(
    back && { orders: back.orders, bots: back.bots ?? {}, ambientEnabled: back.ambientEnabled },
    wanted,
    "the channel's prior ambient policy was restored exactly",
  );
}
