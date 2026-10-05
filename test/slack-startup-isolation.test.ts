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
