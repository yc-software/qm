import { ECSClient, DescribeTasksCommand, type DescribeTasksCommandOutput } from "@aws-sdk/client-ecs";
import type { DurableMap } from "../persistence/durable-map.ts";

export interface FlyPeerClaim {
  taskArn: string;
  stoppedConfirmedAt?: string;
}

export async function claimFlyPeer(opts: {
  peerIds: readonly string[];
  taskArn: string;
  claims: DurableMap<FlyPeerClaim>;
  taskStopped: (taskArn: string) => Promise<boolean>;
}): Promise<string> {
  if (!opts.taskArn || !opts.peerIds.length || new Set(opts.peerIds).size !== opts.peerIds.length)
    throw new Error("Fly peer claims require a task identity and distinct peer IDs");
  if (!opts.claims.update) throw new Error("Fly peer claims require atomic ownership updates");
  const desired = { taskArn: opts.taskArn };
  for (const id of opts.peerIds) {
    if ((await opts.claims.get(id))?.taskArn === opts.taskArn) return id;
  }
  for (const id of opts.peerIds) {
    if ((await opts.claims.putIfAbsent(id, desired)).taskArn === opts.taskArn) return id;
  }
  for (const id of opts.peerIds) {
    const previous = await opts.claims.get(id);
    if (!previous || (!previous.stoppedConfirmedAt && !(await opts.taskStopped(previous.taskArn)))) continue;
    const assigned = await opts.claims.update(id, (current) =>
      current.taskArn === previous.taskArn ? desired : current,
    );
    if (assigned?.taskArn === opts.taskArn) return id;
  }
  throw new Error("No Fly peer is available; previous owners must be confirmed stopped before reuse");
}

export function createEcsTaskStopped(opts: {
  cluster: string;
  describe?: (command: DescribeTasksCommand) => Promise<DescribeTasksCommandOutput>;
}): (taskArn: string) => Promise<boolean> {
  const client = opts.describe ? undefined : new ECSClient({});
  const describe = opts.describe ?? ((command: DescribeTasksCommand) => client!.send(command));
  return async (taskArn) => {
    const result = await describe(new DescribeTasksCommand({ cluster: opts.cluster, tasks: [taskArn] }));
    if (result.failures?.length) return false;
    return (
      result.tasks?.length === 1 && result.tasks[0]?.taskArn === taskArn && result.tasks[0]?.lastStatus === "STOPPED"
    );
  };
}

export async function recordStoppedFlyPeers(opts: {
  peerIds: readonly string[];
  claims: DurableMap<FlyPeerClaim>;
  taskStopped: (taskArn: string) => Promise<boolean>;
}): Promise<void> {
  if (!opts.claims.update) throw new Error("Fly peer claims require atomic ownership updates");
  for (const id of opts.peerIds) {
    const previous = await opts.claims.get(id);
    if (!previous || previous.stoppedConfirmedAt || !(await opts.taskStopped(previous.taskArn))) continue;
    const stoppedConfirmedAt = new Date().toISOString();
    await opts.claims.update(id, (current) =>
      current.taskArn === previous.taskArn ? { ...current, stoppedConfirmedAt } : current,
    );
  }
}
