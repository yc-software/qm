import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

// Regression for slackapi/node-slack-sdk#2656: a failed Socket Mode reconnect was an
// unhandled rejection that terminated core. The vendored SDK retries until shutdown instead.
test("a failed Socket Mode reconnect neither terminates the process nor strands the socket", async () => {
  const source = `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { createRequire } from "node:module";
    import { createDeferredAckReceiver } from ${JSON.stringify(new URL("../src/slack/deferred-ack.ts", import.meta.url).href)};
    const require = createRequire(import.meta.resolve("@slack/socket-mode"));
    const { WebSocketServer } = require("ws");
    const sockets = [];
    let requests = 0;
    let failure;
    const api = createServer((req, res) => {
      requests++;
      res.setHeader("content-type", "application/json");
      if (failure === "network") { res.destroy(); return; }
      res.end(JSON.stringify(failure ? { ok: false, error: failure } : { ok: true, url }));
    });
    const ws = new WebSocketServer({ server: api });
    ws.on("connection", (socket) => {
      sockets.push(socket);
      socket.send(JSON.stringify({ type: "hello" }));
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const url = "ws://127.0.0.1:" + api.address().port;
    const receiver = createDeferredAckReceiver({
      appToken: "xapp-test",
      slackApiUrl: "http://127.0.0.1:" + api.address().port + "/",
      logLevel: "error",
    });
    receiver.client.clientPingTimeoutMS = 20;
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 15000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      await receiver.start();
      for (const kind of ["invalid_auth", "network"]) {
        failure = kind;
        const before = requests;
        const connected = sockets.length;
        sockets.at(-1).terminate();
        await waitFor(() => requests >= before + 2);
        failure = undefined;
        await waitFor(() => sockets.length > connected);
      }
      await receiver.stop();
      const stopped = requests;
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(requests, stopped);
      console.log("reconnect survived");
    } finally {
      await receiver.stop();
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => ws.close(resolve));
      await new Promise((resolve) => api.close(resolve));
    }
  `;
  const result = await run(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", source], {
    timeout: 30_000,
  });
  assert.match(result.stdout, /reconnect survived/);
});
