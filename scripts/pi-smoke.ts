import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { DEFAULT_AGENT_MODEL_ID } from "../src/model/pi-models.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set — cannot run live smoke.");
  process.exit(1);
}

const { app } = buildApp({
  ...loadConfig(),
  port: 0,
  dataDir: mkdtempSync(join(tmpdir(), "pi-smoke-")),
  sessionStore: "memory",
  runStore: "memory",
  harness: "pi",
});

const actor = { externalId: "U1" };
function dm(text: string, thread = "t1"): TurnRequest {
  return { surface: "smoke", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

async function run(label: string, req: TurnRequest): Promise<void> {
  const started = Date.now();
  console.log(`\n=== ${label} ===`);
  console.log(`> ${req.text}`);
  const r = await app.turn(req);
  const ms = Date.now() - started;
  console.log(`STATUS: ${r.status}  (${ms}ms)`);
  console.log(`REPLY : ${(r.reply ?? r.reason ?? "").slice(0, 600)}`);
}

console.log(`model: ${process.env.PI_MODEL ?? DEFAULT_AGENT_MODEL_ID}`);
await run("1. basic generation", dm("Reply with exactly the single word: PONG"));
await run(
  "2. execute tool (sandbox)",
  dm("Use your execute tool to run the command `echo hello-from-sandbox`, then tell me exactly what it printed."),
);
await run(
  "3. write + read tools (workspace)",
  dm(
    "Use the write tool to create a file named fact.txt with exactly the contents: the sky is blue. " +
      "Then use the read tool to read fact.txt back, and tell me its contents.",
  ),
);
await run("4a. multi-turn memory (set)", dm("My favorite number is 7. Please remember it.", "mem"));
await run("4b. multi-turn memory (recall)", dm("What is my favorite number? Reply with just the number.", "mem"));

console.log("\nDONE");
process.exit(0);
