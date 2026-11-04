import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const drainModule = fileURLToPath(new URL("../../chassis/src/drain.ts", import.meta.url));

const fixture = `
import { createServer } from "node:http";
import { drainOnSigterm } from ${JSON.stringify(drainModule)};
const server = createServer((req, res) => {
  res.setHeader("x-content-type-options", "nosniff");
  if (req.url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(": open\\n\\n");
    const beat = setInterval(() => res.write(": beat\\n\\n"), 100);
    res.once("close", () => clearInterval(beat));
    return;
  }
  if (req.url === "/slow") return void setTimeout(() => res.end("slow done"), 1500);
  res.end("ok");
});
drainOnSigterm(server, "fixture");
server.listen(0, "127.0.0.1", () => console.log("port " + server.address().port));
`;

function start(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child: ChildProcess = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const exit = once(child, "exit").then(([code, signal]) => ({ code, signal, at: Date.now() }));
  return { child, exit, stdout: () => stdout };
}

test("SIGTERM ends event streams, finishes in-flight requests, serves until quiet, then exits cleanly", async () => {
  const server = start(["--input-type=module", "-e", fixture]);
  try {
    const deadline = Date.now() + 10_000;
    while (!/port (\d+)/.test(server.stdout()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const base = `http://127.0.0.1:${/port (\d+)/.exec(server.stdout())![1]}`;
    const events = await fetch(`${base}/events`);
    const streamEnded = (async () => {
      for await (const chunk of events.body!) void chunk;
      return Date.now();
    })();
    const slow = fetch(`${base}/slow`).then(async (r) => ({ status: r.status, body: await r.text() }));
    await new Promise((r) => setTimeout(r, 200));
    const signalled = Date.now();
    server.child.kill("SIGTERM");
    assert.ok((await streamEnded) - signalled < 1_000, "event streams end right after SIGTERM");
    const lameDuck = await fetch(`${base}/`);
    assert.equal(await lameDuck.text(), "ok");
    assert.equal(lameDuck.headers.get("connection"), "close");
    assert.deepEqual(await slow, { status: 200, body: "slow done" });
    const { code, signal, at } = await server.exit;
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.ok(at - signalled < 6_000, `exited ${at - signalled} ms after SIGTERM`);
    assert.match(server.stdout(), /\[fixture\] SIGTERM received, draining/);
    await assert.rejects(fetch(`${base}/`));
  } finally {
    server.child.kill("SIGKILL");
  }
});

test("`node server/index.ts` exits cleanly within seconds of SIGTERM", async () => {
  const PORT = "18196";
  const server = start(["server/index.ts"], { PORT, NODE_ENV: "production" });
  try {
    const deadline = Date.now() + 15_000;
    let up = false;
    while (!up && Date.now() < deadline) {
      up = await fetch(`http://127.0.0.1:${PORT}/healthz`).then(
        (r) => r.ok,
        () => false,
      );
      if (!up) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(up, "web-ui should serve /healthz");
    const signalled = Date.now();
    server.child.kill("SIGTERM");
    const { code, signal, at } = await server.exit;
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.ok(at - signalled < 6_000, `exited ${at - signalled} ms after SIGTERM`);
  } finally {
    server.child.kill("SIGKILL");
  }
});
