#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { stagingApiHeaders } from "../src/deployment/postdeploy-smoke.ts";

const core = process.env.CORE_URL ?? "http://localhost:8081";
const principal = process.env.PRINCIPAL ?? "managed-agents-smoke";
const sourceSecret = process.env.CORE_SIGNING_SECRET ?? "";
const portalSecret = process.env.PORTAL_IDENTITY_SECRET ?? "";

const log = (...a: unknown[]) => console.log("[managed-agents-turn]", ...a);

async function main(): Promise<void> {
  if (!sourceSecret || !portalSecret) throw new Error("CORE_SIGNING_SECRET and PORTAL_IDENTITY_SECRET are required");

  const nonce = randomUUID();
  const body = JSON.stringify({
    surface: "web",
    actor: { externalId: principal },
    conversation: { kind: "dm", threadRef: `web:${principal}:managed-agents-turn-${nonce}` },
    text: "Use your execute tool to run exactly this shell command in your agent computer: `echo DO_AGENTS_TURN_OK; uname -sr; pwd; whoami`. Then reply with the exact stdout you got back and nothing else.",
    origin: { kind: "human" },
    addressed: true,
    skipMemory: true,
    idempotencyKey: nonce,
  });

  const path = "/v1/turns";
  const headers = await stagingApiHeaders(principal, sourceSecret, portalSecret, "POST", path, body);

  log(`POST ${core}${path} (this provisions a Managed Agents microVM on the first execute)...`);
  const started = Date.now();
  const res = await fetch(`${core}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(600_000),
  });
  const text = await res.text();
  log(`HTTP ${res.status} in ${Math.round((Date.now() - started) / 1000)}s`);
  if (!res.ok) throw new Error(`turn failed: ${text.slice(0, 2000)}`);

  const turn = JSON.parse(text) as { status?: string; sessionId?: string; reply?: string };
  log("status:", turn.status, "session:", turn.sessionId);
  log("reply:", JSON.stringify(turn.reply));
  if (!turn.reply?.includes("DO_AGENTS_TURN_OK")) throw new Error("the model reply does not contain DO_AGENTS_TURN_OK");
  log("REAL QM TURN EXECUTED IN A Managed Agents SANDBOX");
}

main().catch((e: unknown) => {
  console.error("[managed-agents-turn] FAILED", e);
  process.exit(1);
});
