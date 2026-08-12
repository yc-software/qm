#!/usr/bin/env node
import { hostname } from "node:os";
import {
  derivePairingKey,
  generateEncodedKeyPair,
  pairingVerificationCode,
} from "../common/crypto.js";
import { fetchJson, joinUrl } from "../common/http.js";
import type { EdgeFile } from "../common/protocol.js";
import { loadEdgeConfig, saveEdgeConfig } from "./config.js";
import { callLocalMcp } from "./local-mcp.js";
import { runEdgeWorker } from "./worker.js";

interface ClaimResponse {
  pairingId: string;
  deviceId: string;
  edgeToken: string;
  cliPublicKey: string;
}

function option(
  args: string[],
  name: string,
  fallback?: string,
): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function usage(): never {
  console.error(`Usage:
  inwise-qm-edge pair --relay URL --code CODE [--name DEVICE] [--mcp URL]
  inwise-qm-edge serve
  inwise-qm-edge status`);
  process.exit(2);
}

async function pair(args: string[]): Promise<void> {
  const relayUrl = option(args, "--relay")?.replace(/\/$/, "");
  const code = option(args, "--code")?.toUpperCase();
  const deviceName = option(args, "--name", hostname()) ?? hostname();
  const mcpUrl = option(args, "--mcp", "http://127.0.0.1:43117/mcp")!;
  if (!relayUrl || !code) usage();

  await callLocalMcp(mcpUrl, "get_connection_status", {});
  const keys = generateEncodedKeyPair();
  const claimed = await fetchJson<ClaimResponse>(
    joinUrl(relayUrl, "/v1/pairings/claim"),
    {
      method: "POST",
      body: JSON.stringify({ code, edgePublicKey: keys.publicKey, deviceName }),
    },
  );
  const config: EdgeFile = {
    pairingId: claimed.pairingId,
    relayUrl,
    deviceId: claimed.deviceId,
    edgeToken: claimed.edgeToken,
    edgePublicKey: keys.publicKey,
    edgePrivateKey: keys.privateKey,
    cliPublicKey: claimed.cliPublicKey,
    deviceName,
    mcpUrl,
  };
  saveEdgeConfig(config);
  console.log(`Paired ${deviceName} with QM.`);
  const verificationCode = pairingVerificationCode(
    derivePairingKey(
      keys.privateKey,
      claimed.cliPublicKey,
      claimed.pairingId,
    ),
    claimed.pairingId,
  );
  console.log(`Verification code: ${verificationCode}`);
  console.log(`In QM, run: inwise auth confirm ${verificationCode}`);
  console.log(
    "Run `inwise-qm-edge serve` while using QM (desktop auto-start is a follow-up integration).",
  );
}

async function status(): Promise<void> {
  const config = loadEdgeConfig();
  const [relay, inwise] = await Promise.allSettled([
    fetchJson<{ ok: boolean }>(joinUrl(config.relayUrl, "/healthz"), {}, 5_000),
    callLocalMcp(config.mcpUrl, "get_connection_status", {}),
  ]);
  console.log(
    JSON.stringify(
      {
        paired: true,
        deviceName: config.deviceName,
        relay: relay.status === "fulfilled" ? "online" : "offline",
        inwise: inwise.status === "fulfilled" ? "online" : "offline",
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "pair") return pair(args);
  if (command === "status") return status();
  if (command === "serve") {
    const config = loadEdgeConfig();
    let stopping = false;
    process.once("SIGINT", () => {
      stopping = true;
    });
    process.once("SIGTERM", () => {
      stopping = true;
    });
    console.log(`Inwise QM edge connected for ${config.deviceName}.`);
    return runEdgeWorker(config, {
      shouldStop: () => stopping,
      onError: (error) => console.error(`[inwise-qm-edge] ${error.message}`),
    });
  }
  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
