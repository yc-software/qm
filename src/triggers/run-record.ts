import type { AutomationRun } from "../types.ts";
import { errMessage, reportFailure } from "../util/errors.ts";
import { runTrigger, type TriggerDeps, type TriggerSpec, type TriggerOutcome } from "./run-trigger.ts";

const RUN_DETAIL_MAX_CHARS = 2000;

function runDetail(text: string): string {
  return text.length <= RUN_DETAIL_MAX_CHARS ? text : `${text.slice(0, RUN_DETAIL_MAX_CHARS - 3)}...`;
}

export async function runRecordedTrigger(
  deps: TriggerDeps,
  spec: TriggerSpec,
  history: {
    entry: AutomationRun;
    begin: (entry: AutomationRun) => Promise<unknown>;
    record: (entry: AutomationRun) => Promise<void>;
    now: () => number;
    reply?: (text: string) => string;
  },
): Promise<TriggerOutcome> {
  const record = async (outcome: TriggerOutcome) => {
    await history.record({
      ...history.entry,
      endedAt: history.now(),
      status: outcome.status ?? (outcome.authzFailed ? "refused" : "ok"),
      ...(outcome.note ? { note: runDetail(outcome.note) } : {}),
      ...(outcome.reply !== undefined ? { reply: (history.reply ?? runDetail)(outcome.reply) } : {}),
      ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
    });
  };
  let outcome: TriggerOutcome;
  try {
    outcome = await runTrigger(deps, {
      ...spec,
      onCompleted: async (result) => {
        await record(result);
        await spec.onCompleted?.(result);
      },
      onClaimed: async () => {
        await history.begin(history.entry);
        await spec.onClaimed?.();
      },
    });
  } catch (error) {
    reportFailure("automation execution", error, `fire=${history.entry.fireKey}`);
    await history.record({
      ...history.entry,
      endedAt: history.now(),
      status: "failed",
      note: runDetail(errMessage(error)),
    });
    throw error;
  }
  if (outcome.authzFailed) await record(outcome);
  return outcome;
}
