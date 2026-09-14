import "./auto-fake-sprites.ts";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "../../src/api/server.ts";
import { testConfig } from "./test-config.ts";
import { buildApp, serverDeps } from "../../src/wiring.ts";

if (process.env.NODE_ENV !== "test") throw new Error("synthetic stack requires NODE_ENV=test");
const dataDir = resolve(process.env.SWARM_FIXTURE_DATA_DIR ?? "../swarm-fixture-data");
mkdirSync(dataDir, { recursive: true });
const config = testConfig({
  dataDir,
  harness: "mock",
  anthropicApiKey: "synthetic-unused-with-mock-harness",
  signingSecret: "swarm-local-fixture-source-secret",
  capabilitySecret: "swarm-local-fixture-capability-secret",
  sandboxResourcesEnabled: true,
  backgroundWorkEnabled: process.env.SWARM_FIXTURE_WORKERS === "1",
  port: Number(process.env.SWARM_FIXTURE_PORT ?? 18080),
});
const built = buildApp(config);
const server = createServer(built.app, serverDeps(config, built));
const callers = new Map<string, { kind: "human"; actorId: string; sessionId: string; runId: string }>();
const identities = new Map<string, string>();
for (const principal of ["alice", "bob", "private-carol"]) {
  const threadRef = "web:" + principal + ":swarm-coordination-fixture";
  const result = await built.app.turn({
    surface: "web",
    actor: { externalId: principal },
    conversation: { kind: "dm", threadRef },
    text: "Synthetic private conversation for " + principal + ". Never publish this transcript as character metadata.",
  });
  if (result.status !== "ok") throw new Error("fixture root turn failed: " + JSON.stringify(result));
  const session = (await built.sessions.getByThread(threadRef))!;
  const run = (await built.runs.list({ limit: 10 })).find((run) => run.sessionId === threadRef)!;
  const caller = { kind: "human" as const, actorId: principal, sessionId: session.id, runId: run.id };
  if (principal !== "private-carol") {
    const identity = await built.app.swarms!.character(caller, {
      version: 0,
      name: principal === "alice" ? "Compiler researcher" : "Release reviewer",
      character: { role: principal === "alice" ? "researcher" : "reviewer", topic: "developer tools" },
    });
    identities.set(principal, identity.id);
    await built.app.swarms!.context(caller, { private: "Not part of organization discovery" });
  }
  callers.set(principal, caller);
  console.log(JSON.stringify({ principal, sessionId: session.id, runId: run.id }));
}
const alice = callers.get("alice")!;
const bob = callers.get("bob")!;
await built.app.swarms!.spawn(alice, {
  requestId: "fixture-workers",
  count: 2,
  text: "Compare parser recovery strategies. Keep this assignment private to our swarm.",
});
await built.app.swarms!.sweep();
const workers = (await built.app.swarms!.inspect(alice)).peers.filter((p) => p.parentId);
for (const [index, worker] of workers.entries()) {
  await built.app.swarms!.character(
    { ...alice, sessionId: worker.sessionId! },
    {
      version: 0,
      name: index ? "Parser implementer" : "Parser reviewer",
      character: { role: index ? "implementation" : "review", topic: "parser recovery" },
    },
  );
}
const request = await built.app.swarms!.publish(alice, {
  requestId: "fixture-public-request",
  text: "Review the proposed parser-recovery API. Share only the public compatibility findings.",
  audience: [identities.get("bob")!],
});
await built.app.swarms!.publish(bob, {
  requestId: "fixture-public-reply",
  replyTo: request.id,
  text: "The public API stays compatible. Two malformed-input cases still need coverage.",
  audience: [identities.get("alice")!],
  notify: false,
});
await built.app.swarms!.sweep();
await new Promise<void>((done) => server.listen(config.port, "127.0.0.1", done));
console.log("Real core HTTP app listening on http://127.0.0.1:" + config.port);
console.log(
  "Synthetic principals: alice, bob, private-carol. Mock model and fake sandbox; memory stores. Use /board on the local dev portal.",
);
if (config.backgroundWorkEnabled) built.runtime.start();
const stop = async () => {
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  await built.runtime.stop();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
