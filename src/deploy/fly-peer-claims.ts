import { ECSClient, DescribeTasksCommand, type DescribeTasksCommandOutput } from "@aws-sdk/client-ecs";
import type { KeyedRows, RowTable } from "../persistence/keyed-rows.ts";

export interface FlyPeerClaim {
  taskArn: string;
  stoppedConfirmedAt?: string;
}

export const FLY_PEER_CLAIMS: RowTable<FlyPeerClaim, "peerId"> = {
  table: "fly_peer_claims",
  key: "peerId",
  global: true,
  columns: { peerId: "text", taskArn: "text", stoppedConfirmedAt: "text" },
  migrations: [
    {
      id: "tenancy/fly_peer_claims/0001-typed",
      statements: [
        `SET LOCAL lock_timeout = '5s'`,
        `CREATE TABLE IF NOT EXISTS fly_peer_claims(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
        `ALTER TABLE fly_peer_claims RENAME TO fly_peer_claims_kv`,
        `ALTER INDEX fly_peer_claims_pkey RENAME TO fly_peer_claims_kv_pkey`,
        `CREATE TABLE fly_peer_claims(peer_id TEXT PRIMARY KEY, task_arn TEXT NOT NULL, stopped_confirmed_at TEXT)`,
        `INSERT INTO fly_peer_claims(peer_id, task_arn, stopped_confirmed_at)
           SELECT id, json->>'taskArn', json->>'stoppedConfirmedAt' FROM fly_peer_claims_kv`,
        `DROP TABLE fly_peer_claims_kv`,
        `DO $drop_version$ BEGIN
           IF to_regclass('durable_map_versions') IS NOT NULL THEN
             DELETE FROM durable_map_versions WHERE tbl = 'fly_peer_claims';
           END IF;
         END $drop_version$`,
      ],
    },
  ],
};

export type FlyPeerClaims = Pick<KeyedRows<FlyPeerClaim>, "get" | "putIfAbsent" | "update">;

export async function claimFlyPeer(opts: {
  peerIds: readonly string[];
  taskArn: string;
  claims: FlyPeerClaims;
  taskStopped: (taskArn: string) => Promise<boolean>;
}): Promise<string> {
  if (!opts.taskArn || !opts.peerIds.length || new Set(opts.peerIds).size !== opts.peerIds.length)
    throw new Error("Fly peer claims require a task identity and distinct peer IDs");
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
  claims: FlyPeerClaims;
  taskStopped: (taskArn: string) => Promise<boolean>;
}): Promise<void> {
  for (const id of opts.peerIds) {
    const previous = await opts.claims.get(id);
    if (!previous || previous.stoppedConfirmedAt || !(await opts.taskStopped(previous.taskArn))) continue;
    const stoppedConfirmedAt = new Date().toISOString();
    await opts.claims.update(id, (current) =>
      current.taskArn === previous.taskArn ? { ...current, stoppedConfirmedAt } : current,
    );
  }
}
