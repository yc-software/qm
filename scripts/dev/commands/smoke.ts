import { randomUUID } from "node:crypto";
import { slotPorts } from "../lib/pool.ts";
import { myLease } from "../lib/lease.ts";
import { repoRoot } from "../lib/envctx.ts";
import { EXIT } from "../lib/types.ts";
import { errMessage, sleep } from "../lib/util.ts";

const CHECKS = [
  { name: "web turn", text: "Reply with exactly PONG.", expect: "PONG" },
  {
    name: "sandbox self-API",
    text: 'Use your execute tool to run this exact shell command, then reply with its raw output only: curl -s -o /dev/null -w "selfapi=%{http_code}" -H "x-agent-capability: $AGENT_API_TOKEN" "$AGENT_API_URL/v1/apis"',
    expect: "selfapi=200",
  },
];

interface RunView {
  status?: string;
  error?: string;
  result?: { reply?: string; error?: string };
}

async function turn(portal: string, text: string): Promise<string> {
  const submit = await fetch(`${portal}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: portal },
    body: JSON.stringify({ text, threadRef: `smoke-${randomUUID()}` }),
  });
  const raw = await submit.text();
  if (!submit.ok) return `POST /api/turn ${submit.status}: ${raw}`;
  const body = JSON.parse(raw) as { runId?: string; reply?: string };
  if (!body.runId) return body.reply ?? raw;
  for (;;) {
    const res = await fetch(`${portal}/api/runs/${body.runId}`);
    if (!res.ok) return `GET /api/runs/${body.runId} ${res.status}: ${await res.text()}`;
    const run = (await res.json()) as RunView;
    if (run.status === "done" || run.status === "failed")
      return run.result?.reply ?? run.result?.error ?? run.error ?? run.status;
    await sleep(2000);
  }
}

export async function runSmoke(store: string): Promise<number> {
  const lease = myLease(repoRoot(), store);
  if (!lease) {
    console.error("smoke: no dev instance is up for this worktree (run 'dev up')");
    return EXIT.missingPrereq;
  }
  const portal = `http://localhost:${slotPorts(lease.slot).portal}`;
  let failed = 0;
  for (const check of CHECKS) {
    const started = Date.now();
    const reply = await turn(portal, check.text).catch((err) => `error: ${errMessage(err)}`);
    const ok = reply.includes(check.expect);
    if (!ok) failed++;
    console.log(
      `${ok ? "[ok]" : "[fail]"} ${check.name} (${Math.round((Date.now() - started) / 1000)}s): ${reply.trim()}`,
    );
  }
  return failed ? EXIT.verificationFailed : EXIT.ok;
}
