import { createHash } from "node:crypto";
import { DurableTaskDeferred, type DurableTasks } from "../durable/tasks.ts";
import type { AckGate } from "./deferred-ack.ts";

export interface SlackIngress {
  accept(account: string, body: Record<string, unknown>): Promise<void>;
  register(account: string, replay: (body: Record<string, unknown>, gate: AckGate) => Promise<void>): () => void;
}

export function slackIngressKey(account: string, body: Record<string, unknown>): string {
  const eventId = typeof body.event_id === "string" ? body.event_id : undefined;
  const triggerId = typeof body.trigger_id === "string" ? body.trigger_id : undefined;
  const fallback = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return `slack-ingress:${account}:${String(body.type ?? "command")}:${eventId ?? triggerId ?? fallback}`;
}

export function createSlackIngress(tasks: DurableTasks): SlackIngress {
  const handlers = new Map<string, (body: Record<string, unknown>, gate: AckGate) => Promise<void>>();
  tasks.register("slack.ingest", async (context, input: { account: string; body: Record<string, unknown> }) => {
    const replay = handlers.get(input.account);
    if (!replay) throw new DurableTaskDeferred();
    await context.step("accepted", async () => {
      let accepted = false;
      let failure: Error | undefined;
      await replay(input.body, {
        persisted: () => {
          accepted = true;
        },
        failed: (reason) => {
          if (!accepted) failure = new Error(reason ?? "Slack event processing failed");
        },
      });
      if (failure) throw failure;
      return true;
    });
  });
  return {
    async accept(account, body) {
      await tasks.spawn("slack.ingest", { account, body }, { idempotencyKey: slackIngressKey(account, body) });
    },
    register(account, replay) {
      if (handlers.has(account)) throw new Error(`Slack ingress already registered for ${account}`);
      handlers.set(account, replay);
      return () => {
        if (handlers.get(account) === replay) handlers.delete(account);
      };
    },
  };
}
