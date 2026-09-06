import type { Lease, SessionStore } from "../../sessions/session-store.ts";
import { swallowAs } from "../../util/errors.ts";

const STALLED_KEEPALIVE_RENEWALS = 30;

export interface KeepaliveLiveness {
  progress: () => number;
  onStalled: () => void;
  stalledRenewals?: number;
}

export function startLeaseKeepalive(
  sessions: Pick<SessionStore, "renewLease">,
  lease: Lease,
  intervalMs: number,
  releaseExpected: () => boolean,
  liveness?: KeepaliveLiveness,
): () => void {
  const stalledLimit = liveness?.stalledRenewals ?? STALLED_KEEPALIVE_RENEWALS;
  let lastProgress = liveness?.progress() ?? 0;
  let stalledRenewals = 0;
  const timer = setInterval(() => {
    if (liveness) {
      const seen = liveness.progress();
      if (seen !== lastProgress) {
        lastProgress = seen;
        stalledRenewals = 0;
      } else if (++stalledRenewals >= stalledLimit) {
        clearInterval(timer);
        console.error(
          `[orchestrator] lease keepalive stalled: no turn progress across ${stalledRenewals} renewals — aborting the turn session=${lease.sessionId}`,
        );
        liveness.onStalled();
        return;
      }
    }
    void sessions
      .renewLease(lease)
      .then((renewed) => {
        if (renewed) return;
        clearInterval(timer);
        if (!releaseExpected())
          console.error(`[orchestrator] lease keepalive stopped: lease lost mid-turn session=${lease.sessionId}`);
      })
      .catch(swallowAs("orchestrator: lease keepalive", undefined));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
