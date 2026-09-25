import type { Loop, LoopGovernorConfig, LoopHealth } from "../types.ts";
import type { LoopItemLedger, LoopQueueStats } from "./item-ledger.ts";
import { isDecided, unresolvedOutput, type LoopOutputStore } from "./output-store.ts";
import { undeclaredShipActions } from "./ship-gate.ts";

export interface LoopVitals {
  queue: LoopQueueStats;
  openOutputs: number;
  decidedOutputs: number;
  returnedOutputs: number;
  undeclaredShipActions?: string[];
}

type GovernorActionType = "quarantine" | "throttle" | "ping";

interface GovernorAction {
  type: GovernorActionType;
  reason: string;
  recommendation?: string;
}

export interface GovernorVerdict {
  health: LoopHealth;
  reason?: string;
  actions: GovernorAction[];
  throttle: boolean;
  escalate: boolean;
}

const DEFAULTS: Required<
  Pick<LoopGovernorConfig, "maxConsecutiveFailedFires" | "maxReturnRate" | "returnRateMinDecisions">
> = {
  maxConsecutiveFailedFires: 3,
  maxReturnRate: 0.5,
  returnRateMinDecisions: 4,
};

const SEVERITY: Record<LoopHealth, number> = { healthy: 0, degraded: 1, failing: 2, quarantined: 3 };

export function healthWorsened(previous: LoopHealth, next: LoopHealth): boolean {
  return SEVERITY[next] > SEVERITY[previous];
}

function returnRate(vitals: LoopVitals): number {
  return vitals.decidedOutputs === 0 ? 0 : vitals.returnedOutputs / vitals.decidedOutputs;
}

export function evaluateGovernor(loop: Loop, vitals: LoopVitals, now: number): GovernorVerdict {
  const config = { ...DEFAULTS, ...loop.governor };
  const caps = loop.caps;
  const actions: GovernorAction[] = [];
  let health: LoopHealth = "healthy";
  let reason: string | undefined;

  const raise = (next: LoopHealth, why: string) => {
    if (SEVERITY[next] > SEVERITY[health]) {
      health = next;
      reason = why;
    }
  };

  const undeclared = vitals.undeclaredShipActions ?? [];
  if (undeclared.length > 0) {
    const why = `undeclared ship action: ${undeclared.join(", ")}`;
    actions.push({
      type: "quarantine",
      reason: why,
      recommendation: "declare the action in the playbook or narrow the loop",
    });
    raise("quarantined", why);
  }

  const failedFires = loop.consecutiveFailedFires ?? 0;
  if (failedFires >= config.maxConsecutiveFailedFires) {
    const why = `${failedFires} consecutive failed fires`;
    actions.push({ type: "quarantine", reason: why, recommendation: "inspect the latest run before resuming" });
    raise("quarantined", why);
  } else if (failedFires >= 2) {
    raise("failing", `${failedFires} consecutive failed fires`);
  }

  const rate = returnRate(vitals);
  if (vitals.decidedOutputs >= config.returnRateMinDecisions && rate > config.maxReturnRate) {
    const why = `${Math.round(rate * 100)}% of reviewed outputs were returned`;
    actions.push({
      type: "throttle",
      reason: why,
      recommendation: "the playbook is producing work people don't want — revise it",
    });
    raise("failing", why);
  }

  if (config.maxQueueDepth !== undefined && vitals.queue.queued > config.maxQueueDepth) {
    const why = `${vitals.queue.queued} items queued`;
    actions.push({ type: "throttle", reason: why, recommendation: "intake is outrunning the work stage" });
    raise("degraded", why);
  }

  if (config.maxQueueAgeMs !== undefined && (vitals.queue.oldestQueuedAgeMs ?? 0) > config.maxQueueAgeMs) {
    const why = `oldest queued item is ${Math.round((vitals.queue.oldestQueuedAgeMs ?? 0) / 60_000)} minutes old`;
    actions.push({ type: "ping", reason: why, recommendation: "work is not draining" });
    raise("degraded", why);
  }

  if (config.staleFireMs !== undefined && now - (loop.lastFiredAt ?? loop.createdAt) > config.staleFireMs) {
    const why = `no fire in ${Math.round((now - (loop.lastFiredAt ?? loop.createdAt)) / 60_000)} minutes`;
    actions.push({ type: "ping", reason: why, recommendation: "the trigger looks dead" });
    raise("degraded", why);
  }

  if (caps?.maxOpenOutputs !== undefined && vitals.openOutputs >= caps.maxOpenOutputs) {
    const why = `${vitals.openOutputs} outputs waiting for review`;
    actions.push({
      type: "ping",
      reason: why,
      recommendation: "reviewer saturation — throttle intake?",
    });
    raise("degraded", why);
  }

  return {
    health,
    ...(reason !== undefined ? { reason } : {}),
    actions,
    throttle: actions.some((action) => action.type === "throttle"),
    escalate: healthWorsened(loop.health, health),
  };
}

export async function collectVitals(
  loop: Loop,
  stores: { items: LoopItemLedger; outputs: LoopOutputStore },
  now: number,
): Promise<LoopVitals> {
  const [queue, outputs] = await Promise.all([stores.items.stats(loop.id, now), stores.outputs.byLoop(loop.id)]);
  const decided = outputs.filter(isDecided);
  const undeclared = undeclaredShipActions(
    loop,
    outputs.filter((output) => output.state === "staged" || unresolvedOutput(output)),
  );
  return {
    queue,
    openOutputs: outputs.filter(unresolvedOutput).length,
    decidedOutputs: decided.length,
    returnedOutputs: decided.filter((output) => output.state === "returned").length,
    ...(undeclared.length > 0 ? { undeclaredShipActions: undeclared } : {}),
  };
}
