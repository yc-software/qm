import { sleep } from "../util/async.ts";
import { swallow } from "../util/errors.ts";
import type { CmaClient } from "./cma-client.ts";

const WORK_POLL_BLOCK_MS = 900;
const WORK_POLL_PAUSE_MS = 1_000;
const WORK_POLL_EMPTY_PAUSE_MS = 50;
const WORK_HEARTBEAT_MS = 30_000;

export interface CmaWorkAttendantOptions {
  client: CmaClient;
  environmentId: string;
}

export interface CmaWorkAttendant {
  beginTurn(cmaSessionId: string): () => Promise<void>;
  stop(): Promise<void>;
}

interface ActiveTurn {
  holds: Map<string, Promise<void>>;
  release: AbortController;
}

export function createCmaWorkAttendant(opts: CmaWorkAttendantOptions): CmaWorkAttendant {
  const turns = new Map<string, ActiveTurn>();
  let stopped = false;
  let loop: Promise<void> | null = null;

  const holdItem = async (workId: string, signal: AbortSignal): Promise<void> => {
    let expected: string | undefined = "NO_HEARTBEAT";
    try {
      while (!signal.aborted) {
        try {
          const beat = await opts.client.heartbeatWork(
            opts.environmentId,
            workId,
            expected ? { expectedLastHeartbeat: expected } : {},
          );
          expected = beat.last_heartbeat ?? undefined;
        } catch (error) {
          swallow("cma-work: heartbeat", error);
          expected = undefined;
        }
        await sleep(WORK_HEARTBEAT_MS, { signal });
      }
    } finally {
      await opts.client.stopWork(opts.environmentId, workId).catch((error: unknown) => {
        swallow("cma-work: stop", error);
      });
    }
  };

  const run = async (): Promise<void> => {
    while (!stopped && turns.size > 0) {
      let item;
      try {
        item = await opts.client.pollWork(opts.environmentId, { blockMs: WORK_POLL_BLOCK_MS });
      } catch (error) {
        swallow("cma-work: poll", error);
        await sleep(WORK_POLL_PAUSE_MS);
        continue;
      }
      if (stopped || turns.size === 0) return;
      if (!item) {
        await sleep(WORK_POLL_EMPTY_PAUSE_MS);
        continue;
      }
      const turn = item.data.type === "session" ? turns.get(item.data.id) : undefined;
      if (!turn) {
        await sleep(WORK_POLL_PAUSE_MS);
        continue;
      }
      try {
        await opts.client.ackWork(opts.environmentId, item.id);
      } catch (error) {
        swallow("cma-work: ack", error);
        continue;
      }
      turn.holds.set(item.id, holdItem(item.id, turn.release.signal));
    }
  };

  const ensureLoop = (): void => {
    loop ??= run().finally(() => {
      loop = null;
      if (!stopped && turns.size > 0) ensureLoop();
    });
  };

  return {
    beginTurn(cmaSessionId) {
      const turn: ActiveTurn = { holds: new Map(), release: new AbortController() };
      turns.set(cmaSessionId, turn);
      ensureLoop();
      return async () => {
        if (turns.get(cmaSessionId) === turn) turns.delete(cmaSessionId);
        turn.release.abort();
        await Promise.allSettled(turn.holds.values());
      };
    },
    async stop() {
      stopped = true;
      const holds = [...turns.values()].flatMap((turn) => {
        turn.release.abort();
        return [...turn.holds.values()];
      });
      turns.clear();
      await Promise.allSettled(holds);
      await loop?.catch(() => undefined);
    },
  };
}
