import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { startSignalPoll, type RunSignalStore } from "../runs/run-signal-store.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import type { TurnHalt } from "./turn-tool-state.ts";
import type { TurnRequestSettings } from "./turn-request.ts";
import type { HarnessTurnInput } from "./harness.ts";
import type { SteerIntake } from "./harness-shared.ts";
import { recordedMessageTimestamps } from "./replay.ts";

export interface TurnStop {
  userAborted: boolean;
  abortReason?: string;
}

export function watchTurnSignals(o: {
  turn: HarnessTurnInput;
  session: AgentSession;
  settings: Pick<TurnRequestSettings, "addDocuments">;
  halt: Pick<TurnHalt, "setSilent">;
  signals: RunSignalStore | undefined;
  toolAbort: AbortController;
  pendingSteers: Array<SteerIntake & { prompt: string }>;
  stop: TurnStop;
}): { release: () => Promise<void> } {
  const { turn, session, settings, halt, signals, toolAbort, pendingSteers, stop } = o;
  const onCancel = (): void => {
    toolAbort.abort();
    session.clearQueue();
    void session.abort().catch(swallowAs("pi: lease-lost abort", undefined));
  };
  if (turn.cancel) {
    if (turn.cancel.aborted) onCancel();
    else turn.cancel.addEventListener("abort", onCancel, { once: true });
  }
  const steeredSeen = recordedMessageTimestamps(turn.history);
  const stopSignalPoll =
    signals && turn.runId
      ? startSignalPoll(
          signals,
          turn.runId,
          {
            onSteer: async (text, ts, request, acknowledge) => {
              if (ts && steeredSeen.has(ts)) return;
              const prepared = await turn.prepareSteer?.(text, request);
              const prompt = prepared?.text ?? text;
              if (!session.isStreaming || toolAbort.signal.aborted) return false;
              const steer = {
                text,
                prompt,
                ts,
                attachments: prepared?.attachments,
                images: prepared?.images,
                author: prepared?.author,
                acknowledge,
              };
              pendingSteers.push(steer);
              if (ts) steeredSeen.add(ts);
              if (prepared?.documents?.length) settings.addDocuments(prepared.documents);
              halt.setSilent(false);
              try {
                await session.steer(
                  prompt,
                  prepared?.images?.map((image) => ({
                    type: "image" as const,
                    mimeType: image.mimeType,
                    data: image.dataBase64,
                  })),
                );
              } catch (error) {
                const at = pendingSteers.indexOf(steer);
                if (at >= 0) pendingSteers.splice(at, 1);
                if (ts) steeredSeen.delete(ts);
                throw error;
              }
              return false;
            },
            onAbort: async (reason) => {
              stop.userAborted = true;
              stop.abortReason ??= reason;
              toolAbort.abort();
              session.clearQueue();
              await session.abort();
            },
          },
          { onError: (e) => swallow("pi: run signal poll", e) },
        )
      : null;
  return {
    release: async () => {
      turn.cancel?.removeEventListener("abort", onCancel);
      await stopSignalPoll?.();
    },
  };
}
