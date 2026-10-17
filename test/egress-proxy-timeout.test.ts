import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, createServer, request, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const envoy = process.argv[2];
const config = process.argv[3] ?? new URL("../deploy/egress-proxy/envoy.yaml", import.meta.url).pathname;
const close = (server: Server) => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
};
const listen = (server: Server, port = 0) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

test(
  "HTTP egress preserves delayed responses, complete streams and client deadlines",
  { skip: !envoy, timeout: 45_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "qm-egress-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const cancellation = Promise.withResolvers<void>();
    const origin = createServer((req, res) => {
      assert.equal(req.headers["proxy-authorization"], undefined);
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("start\n");
        const timers = [4_000, 8_000, 12_000].map((ms) => setTimeout(() => res.write("chunk\n"), ms));
        timers.push(setTimeout(() => res.end("finish\n"), 16_500));
        res.once("close", () => timers.forEach(clearTimeout));
      } else {
        const timer = setTimeout(() => res.end("complete\n"), req.url === "/fast" ? 0 : 16_500);
        res.once("close", () => {
          clearTimeout(timer);
          if (req.url === "/cancel") cancellation.resolve();
        });
      }
    });
    t.after(() => close(origin));
    const originPort = await listen(origin);
    const authorization = "Basic cWE6c3ludGhldGlj";
    const authz = createServer((req, res) => {
      if (req.headers["proxy-authorization"] !== authorization) return void res.writeHead(407).end();
      if (req.headers["x-egress-authority"] !== `fixture.invalid:${originPort}`) return void res.writeHead(403).end();
      res.writeHead(200, { "x-egress-upstream-address": `127.0.0.1:${originPort}` }).end();
    });
    t.after(() => close(authz));
    await listen(authz, 48081);
    const logPath = join(directory, "envoy.log");
    const log = await open(logPath, "w");
    const child = spawn(envoy!, ["-c", config, "--concurrency", "1", "--log-level", "warning"], {
      stdio: ["ignore", log.fd, log.fd],
    });
    await log.close();
    const exited = new Promise((resolve) => child.once("exit", resolve).once("error", resolve));
    t.after(async () => {
      child.kill("SIGTERM");
      await exited;
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if ((await readFile(logPath, "utf8")).includes("error initializing configuration")) break;
      if (
        await new Promise<boolean>((resolve) => {
          const req = request({ socketPath: "/tmp/envoy-admin.sock", path: "/ready", timeout: 100 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          });
          req.on("error", () => resolve(false));
          req.on("timeout", () => req.destroy());
          req.end();
        })
      ) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, await readFile(logPath, "utf8"));
    const agent = new Agent({ keepAlive: true });
    t.after(() => agent.destroy());
    const get = (path: string, timeout = 25_000) =>
      new Promise<{ status: number; body: string; complete: boolean; reused: boolean }>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: 48080,
            path: `http://fixture.invalid:${originPort}${path}`,
            headers: { host: `fixture.invalid:${originPort}`, "proxy-authorization": authorization },
            agent,
            timeout,
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            const result = () => ({ status: res.statusCode!, body, complete: res.complete, reused: req.reusedSocket });
            res.on("end", () => resolve(result()));
            res.on("error", () => resolve(result()));
          },
        );
        req.on("timeout", () => req.destroy(new Error("client deadline")));
        req.on("error", reject);
        req.end();
      });
    const [delayed, streamed] = await Promise.all([get("/delay"), get("/stream")]);
    assert.deepEqual([delayed.status, delayed.body, delayed.complete], [200, "complete\n", true]);
    assert.deepEqual(
      [streamed.status, streamed.body, streamed.complete],
      [200, "start\nchunk\nchunk\nchunk\nfinish\n", true],
    );
    const reused = await get("/fast");
    assert.deepEqual([reused.status, reused.body, reused.complete, reused.reused], [200, "complete\n", true, true]);
    await assert.rejects(get("/cancel", 200), /client deadline/);
    await Promise.race([cancellation.promise, delay(1_000).then(() => assert.fail("upstream cancellation timed out"))]);
  },
);
