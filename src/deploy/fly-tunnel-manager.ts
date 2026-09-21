import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createSweeper } from "../util/sweeper.ts";
import { claimFlyPeer, createEcsTaskStopped, recordStoppedFlyPeers, type FlyPeerClaim } from "./fly-peer-claims.ts";
import { startFlyPrivateTunnel, type FlyPrivateTunnel } from "./fly-private-tunnel.ts";

export interface FlyWireguardPeer {
  id: string;
  config: string;
}

export function parseFlyWireguardPeers(raw: string): FlyWireguardPeer[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("FLY_DEPLOY_WIREGUARD_PEERS must be a JSON array");
  }
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.some((p) => !p || typeof p.id !== "string" || !p.id || typeof p.config !== "string" || !p.config) ||
    new Set(value.map((p) => p.id)).size !== value.length
  )
    throw new Error("Fly private connectivity requires at least two distinct WireGuard peers");
  const peers = value.map((peer) => {
    const keys = [...peer.config.matchAll(/^\s*PrivateKey\s*=\s*([A-Za-z0-9+/]+=*)\s*$/gm)];
    if (keys.length !== 1 || Buffer.from(keys[0]![1]!, "base64").length !== 32)
      throw new Error("Each Fly WireGuard peer must contain one valid private key");
    return {
      id: createHash("sha256")
        .update(
          createPublicKey(
            createPrivateKey({
              key: Buffer.concat([
                Buffer.from("302e020100300506032b656e04220420", "hex"),
                Buffer.from(keys[0]![1]!, "base64"),
              ]),
              format: "der",
              type: "pkcs8",
            }),
          ).export({ format: "der", type: "spki" }),
        )
        .digest("hex"),
      config: peer.config,
    };
  });
  if (new Set(peers.map((peer) => peer.id)).size !== peers.length)
    throw new Error("Fly WireGuard peers must have distinct identities");
  return peers;
}

export function createFlyTunnelManager(opts: {
  peers: FlyWireguardPeer[];
  claims: DurableMap<FlyPeerClaim>;
  metadataUri: string;
  executable: string;
  port?: number;
}) {
  let starting: Promise<number> | undefined;
  let tunnel: FlyPrivateTunnel | undefined;
  let stopped = false;
  let collecting = false;

  const sweeper = createSweeper(
    async () => {
      if (collecting || stopped) return;
      collecting = true;
      try {
        const { shared } = await context();
        await recordStoppedFlyPeers(shared);
      } finally {
        collecting = false;
      }
    },
    60_000,
    { label: "fly-peer-termination", immediate: true },
  );
  async function context() {
    const uri = new URL(opts.metadataUri);
    if (uri.protocol !== "http:" || uri.hostname !== "169.254.170.2")
      throw new Error("Fly private connectivity requires ECS task metadata");
    const response = await fetch(`${uri.href.replace(/\/$/, "")}/task`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Unable to read ECS task identity for Fly private connectivity");
    const metadata = (await response.json()) as { TaskARN?: string; Cluster?: string; LaunchType?: string };
    if (metadata.LaunchType !== "FARGATE" || !metadata.TaskARN || !metadata.Cluster)
      throw new Error("Fly private connectivity requires a Fargate task identity");
    const taskStopped = createEcsTaskStopped({ cluster: metadata.Cluster });
    const shared = { claims: opts.claims, peerIds: opts.peers.map((p) => p.id), taskStopped };
    return { shared, taskArn: metadata.TaskARN };
  }
  async function start(): Promise<number> {
    const previous = tunnel;
    tunnel = undefined;
    await previous?.stop();
    const { shared, taskArn } = await context();
    const peerId = await claimFlyPeer({ ...shared, taskArn });
    if (stopped) throw new Error("Fly tunnel manager is stopped");
    tunnel = await startFlyPrivateTunnel({
      executable: opts.executable,
      port: opts.port,
      wireguardConfig: opts.peers.find((p) => p.id === peerId)!.config,
    });
    if (stopped) {
      await tunnel.stop();
      throw new Error("Fly tunnel manager is stopped");
    }
    sweeper.start();
    return tunnel.port;
  }
  return {
    monitor(): void {
      if (!stopped) sweeper.start();
    },
    async ensure(): Promise<number> {
      if (stopped) throw new Error("Fly tunnel manager is stopped");
      if (tunnel && !tunnel.isAlive()) starting = undefined;
      if (!starting)
        starting = start().catch((error) => {
          starting = undefined;
          throw error;
        });
      return starting;
    },
    async stop(): Promise<void> {
      stopped = true;
      await sweeper.stop();
      await starting?.catch(() => {});
      await tunnel?.stop();
    },
  };
}
