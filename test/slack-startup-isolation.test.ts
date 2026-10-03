import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("real Bolt rejects inactive credentials without terminating core or a healthy Slack account", async () => {
  const source = `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { startSlackPlugin } from ${JSON.stringify(new URL("../src/slack/index.ts", import.meta.url).href)};
    const requests = [];
    const api = createServer(async (req, res) => {
      requests.push(req.url);
      const token = req.headers.authorization ?? "";
      const error = ["account_inactive", "invalid_auth", "token_revoked"].find(value => token.includes(value));
      const body = error ? { ok: false, error } : req.url.endsWith("/auth.test")
        ? { ok: true, team_id: "T1", user_id: "U1", bot_id: "B1", user: "healthy", team: "test" }
        : { ok: true, members: [], channels: [], emoji: {} };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
    let starts = 0;
    let stops = 0;
    const config = {
      apiUrl: "http://127.0.0.1:" + api.address().port + "/",
      coreSingleton: false,
      identityEmail: "0",
      receiverFactory: () => ({ init() {}, async start() { starts++; }, async stop() { stops++; } }),
    };
    const core = { ackEmojiOverride: async () => null };
    let healthy;
    try {
      healthy = await startSlackPlugin({ ...config, accountId: "healthy", botToken: "xoxb-healthy" }, core);
      for (const error of ["account_inactive", "invalid_auth", "token_revoked"]) {
        await assert.rejects(startSlackPlugin({ ...config, accountId: error, botToken: "xoxb-" + error }, core),
          err => err.data?.error === error);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(starts, 1);
      assert.equal(stops, 3);
      assert.equal(requests.filter(path => path.endsWith("/auth.test")).length, 5);
    } finally {
      await healthy?.stop();
      await new Promise(resolve => api.close(resolve));
    }
    assert.equal(stops, 4);
    console.log("healthy account survived");
  `;
  const result = await run(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", source], {
    timeout: 20_000,
  });
  assert.match(result.stdout, /healthy account survived/);
});

test("real Socket Mode reconnect failures recover and shutdown fences a pending connection without a hello", async () => {
  const source = `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { createRequire } from "node:module";
    import { createDeferredAckReceiver } from ${JSON.stringify(new URL("../src/slack/deferred-ack.ts", import.meta.url).href)};
    const require = createRequire(import.meta.resolve("@slack/socket-mode"));
    const { WebSocketServer } = require("ws");
    const sockets = [];
    let requests = 0;
    let inactive = false;
    let holdOpen = false;
    let heldResponse;
    let hello = true;
    const api = createServer((req, res) => {
      requests++;
      if (holdOpen) { heldResponse = res; return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(inactive ? { ok: false, error: "invalid_auth" } : { ok: true, url }));
    });
    const ws = new WebSocketServer({ server: api });
    ws.on("connection", socket => {
      sockets.push(socket);
      if (hello) socket.send(JSON.stringify({ type: "hello" }));
    });
    await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
    const url = "ws://127.0.0.1:" + api.address().port;
    const receiver = createDeferredAckReceiver({ appToken: "xapp-test", slackApiUrl: "http://127.0.0.1:" + api.address().port + "/", logLevel: "error" });
    const waitFor = async predicate => {
      const deadline = Date.now() + 20000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "timed out waiting for socket lifecycle");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    try {
      await receiver.start();
      inactive = true;
      sockets.at(-1).terminate();
      await waitFor(() => requests >= 2);
      await new Promise(resolve => setTimeout(resolve, 50));
      inactive = false;
      await waitFor(() => sockets.length >= 2);
      assert.equal(requests, 3);
      holdOpen = true;
      sockets.at(-1).terminate();
      await waitFor(() => heldResponse);
      const stopped = receiver.stop();
      hello = false;
      heldResponse.setHeader("content-type", "application/json");
      heldResponse.end(JSON.stringify({ ok: true, url }));
      await Promise.race([stopped, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("stop hung awaiting hello")), 2000); timer.unref(); })]);
      const stoppedRequests = requests;
      await new Promise(resolve => setTimeout(resolve, 5100));
      assert.equal(requests, stoppedRequests);
      assert.ok(sockets.every(socket => socket.readyState === 3));
      console.log("reconnect recovered and shutdown fenced");
    } finally {
      await receiver.stop();
      for (const socket of sockets) socket.terminate();
      await new Promise(resolve => ws.close(resolve));
      await new Promise(resolve => api.close(resolve));
    }
  `;
  const result = await run(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", source], {
    timeout: 40_000,
  });
  assert.match(result.stdout, /reconnect recovered and shutdown fenced/);
});

test("real Socket Mode startup rejects a socket that never sends hello and closes it", async () => {
  const source = `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { createRequire } from "node:module";
    import { createDeferredAckReceiver } from ${JSON.stringify(new URL("../src/slack/deferred-ack.ts", import.meta.url).href)};
    const require = createRequire(import.meta.resolve("@slack/socket-mode"));
    const { WebSocketServer } = require("ws");
    const sockets = [];
    const api = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, url: "ws://127.0.0.1:" + api.address().port }));
    });
    const ws = new WebSocketServer({ server: api });
    ws.on("connection", socket => { sockets.push(socket); });
    await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
    const receiver = createDeferredAckReceiver({ appToken: "xapp-test", slackApiUrl: "http://127.0.0.1:" + api.address().port + "/", logLevel: "error" });
    try {
      await assert.rejects(receiver.start());
      await receiver.stop();
      assert.equal(sockets.length, 1);
      if (sockets[0].readyState !== 3) await new Promise(resolve => sockets[0].once("close", resolve));
      assert.equal(sockets[0].readyState, 3);
      console.log("hello deadline closed stalled socket");
    } finally {
      await receiver.stop();
      for (const socket of sockets) socket.terminate();
      await new Promise(resolve => ws.close(resolve));
      await new Promise(resolve => api.close(resolve));
    }
  `;
  const result = await run(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", source], {
    timeout: 20_000,
  });
  assert.match(result.stdout, /hello deadline closed stalled socket/);
});
