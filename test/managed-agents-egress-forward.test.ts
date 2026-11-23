import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const forwarder = fileURLToPath(new URL("../src/sandbox/managed-agents-egress-forward.mjs", import.meta.url));

async function listening(server: Server | ReturnType<typeof createHttpServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listening(probe);
  probe.close();
  await once(probe, "close");
  return port;
}

async function waitFor(path: string): Promise<void> {
  for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(path), `${path} never appeared`);
}

function proxiedGet(port: number, url: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nProxy-Authorization: Basic ${Buffer.from(`x:${token}`).toString("base64")}\r\nConnection: close\r\n\r\n`,
      ),
    );
    let body = "";
    socket.on("data", (chunk) => (body += chunk.toString()));
    socket.on("end", () => resolve(body.slice(body.indexOf("\r\n\r\n") + 4)));
    socket.on("error", reject);
  });
}

test("the forwarder tunnels each connection to the egress proxy through the session's own proxy", async (t) => {
  const egressProxy = createHttpServer((req, res) =>
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end(`${req.method} ${req.url} ${req.headers["proxy-authorization"]}`),
  );
  const egressPort = await listening(egressProxy);
  t.after(() => egressProxy.close());
  const connects: string[] = [];
  const sessionProxy = createServer((client) => {
    client.once("data", (head) => {
      const line = head.toString().split("\r\n")[0] ?? "";
      connects.push(line);
      const [host, port] = line.split(" ")[1]!.split(":");
      const upstream = connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
  });
  const sessionPort = await listening(sessionProxy);
  t.after(() => sessionProxy.close());

  const dir = mkdtempSync(join(tmpdir(), "egress-forward-"));
  writeFileSync(join(dir, "proxy"), `http://127.0.0.1:${egressPort}`);
  const port = await freePort();
  const child = spawn(process.execPath, [forwarder, dir, String(port)], {
    env: { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${sessionPort}`, https_proxy: "" },
    stdio: "ignore",
  });
  t.after(() => child.kill());
  await waitFor(join(dir, "pid"));

  const body = await proxiedGet(port, "http://destination.test/path", "tok");
  assert.match(body, new RegExp(`GET http://destination.test/path Basic ${Buffer.from("x:tok").toString("base64")}`));
  assert.deepEqual(connects, [`CONNECT 127.0.0.1:${egressPort} HTTP/1.1`]);
});
