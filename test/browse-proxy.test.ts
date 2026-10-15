import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

const { startBrowserProxy } = await import(
  new URL("../skills-seed/browse/scripts/browser-proxy.mjs", import.meta.url).href
);
const require = createRequire(import.meta.url);
const envKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

async function bundle() {
  const dir = await mkdtemp(join(tmpdir(), "browse-proxy-test-"));
  await mkdir(join(dir, "lib"));
  await writeFile(
    join(dir, "lib", "utilsBundle.js"),
    `const ws=require(${JSON.stringify(require.resolve("ws"))});module.exports={ws,wsServer:ws.WebSocketServer,HttpsProxyAgent:require(${JSON.stringify(require.resolve("https-proxy-agent"))}).HttpsProxyAgent,getProxyForUrl:require(${JSON.stringify(require.resolve("proxy-from-env"))}).getProxyForUrl};`,
  );
  return { modulePath: join(dir, "index.mjs"), remove: () => rm(dir, { recursive: true, force: true }) };
}

async function withCleanProxy<T>(run: () => Promise<T>) {
  const previous = envKeys.map((key) => [key, process.env[key]] as const);
  for (const key of envKeys) delete process.env[key];
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("browser proxy leaves direct CDP endpoints untouched", async () =>
  withCleanProxy(async () => {
    const fixture = await bundle();
    try {
      const proxy = await startBrowserProxy("wss://browser.example/session", fixture.modulePath);
      assert.equal(proxy.endpoint, "wss://browser.example/session");
      const failure = proxy.getError(new Error("connect EAI_AGAIN browser.example wss://browser.example/session"));
      assert.match(failure.message, /EAI_AGAIN/);
      assert.doesNotMatch(failure.message, /browser.example|wss:\/\//);
      await proxy.close();
    } finally {
      await fixture.remove();
    }
  }));

test("browser proxy uses maintained CONNECT routing and retains faults after message relay", async () =>
  withCleanProxy(async () => {
    const fixture = await bundle();
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(upstream, "listening");
    upstream.on("connection", (socket) => socket.on("message", (data, binary) => socket.send(data, { binary })));
    const connections = new Set<{ destroy(): unknown }>();
    let tunnelCount = 0;
    const forward = createServer();
    forward.on("connect", (request, socket, head) => {
      tunnelCount++;
      const destination = connect((upstream.address() as AddressInfo).port, "127.0.0.1");
      connections.add(socket);
      connections.add(destination);
      socket.on("error", () => destination.destroy());
      destination.on("error", () => socket.destroy());
      socket.once("close", () => {
        connections.delete(socket);
        destination.destroy();
      });
      destination.once("close", () => {
        connections.delete(destination);
        socket.destroy();
      });
      destination.once("connect", () => {
        assert.equal(request.url, `unresolvable.browser.invalid:${(upstream.address() as AddressInfo).port}`);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) destination.write(head);
        socket.pipe(destination).pipe(socket);
      });
    });
    forward.listen(0, "127.0.0.1");
    await once(forward, "listening");
    process.env.HTTP_PROXY = `http://127.0.0.1:${(forward.address() as AddressInfo).port}`;
    let proxy: Awaited<ReturnType<typeof startBrowserProxy>> | undefined;
    let client: WebSocket | undefined;
    try {
      proxy = await startBrowserProxy(
        `ws://unresolvable.browser.invalid:${(upstream.address() as AddressInfo).port}/fixed-browser`,
        fixture.modulePath,
      );
      assert.match(proxy.endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/[\w-]+$/);
      const invalid = new WebSocket(proxy.endpoint + "wrong");
      await assert.rejects(once(invalid, "open"), /400/);
      assert.equal(tunnelCount, 0);
      client = new WebSocket(proxy.endpoint);
      await once(client, "open");
      for (const [payload, binary] of [
        ["first", false],
        [Buffer.alloc(4 * 1024 * 1024, 97), true],
        ["last", false],
      ] as const) {
        const received: Promise<unknown[]> = once(client, "message");
        client.send(payload, { binary });
        const [data, actualBinary]: unknown[] = await received;
        assert.deepEqual(data, Buffer.from(payload));
        assert.equal(actualBinary, binary);
      }
      assert.equal(tunnelCount, 1);
      assert.equal(proxy.getError(), undefined);
      const closed = once(client, "close");
      const remote = [...upstream.clients][0] as unknown as { _socket: { write(data: Buffer): void } };
      remote._socket.write(Buffer.from([0x83, 0x00]));
      await closed;
      assert.match(proxy.getError()?.message, /WS_ERR_INVALID_OPCODE/);
      assert.match(proxy.getError()?.message, /Invalid WebSocket frame/);
      assert.doesNotMatch(String(proxy.getError()?.stack), /unresolvable.browser.invalid|fixed-browser/);
      await Promise.all([proxy.close(), proxy.close()]);
    } finally {
      client?.terminate();
      await proxy?.close();
      for (const socket of connections) socket.destroy();
      for (const socket of upstream.clients) socket.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => forward.close(() => resolve()));
      await fixture.remove();
    }
  }));

for (const proxied of [false, true]) {
  for (const suffix of ["", "/tenant/browser?token=synthetic-secret"]) {
    test(`browser discovery preserves ${suffix ? "path/query" : "root"} before ${proxied ? "proxy" : "direct"} routing`, async () =>
      withCleanProxy(async () => {
        const fixture = await bundle();
        const requests: string[] = [];
        const discovery = createServer((request, response) => {
          requests.push(request.url!);
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ webSocketDebuggerUrl: "wss://browser.invalid/fixed-secret" }));
        });
        discovery.listen(0, "127.0.0.1");
        await once(discovery, "listening");
        if (proxied) process.env.HTTPS_PROXY = "http://127.0.0.1:1";
        try {
          const proxy = await startBrowserProxy(
            `http://127.0.0.1:${(discovery.address() as AddressInfo).port}${suffix}`,
            fixture.modulePath,
          );
          assert.deepEqual(requests, [
            suffix ? "/tenant/browser/json/version/?token=synthetic-secret" : "/json/version/",
          ]);
          if (proxied) assert.match(proxy.endpoint, /^ws:\/\/127\.0\.0\.1:/);
          else assert.equal(proxy.endpoint, "wss://browser.invalid/fixed-secret");
          await proxy.close();
        } finally {
          await new Promise<void>((resolve) => discovery.close(() => resolve()));
          await fixture.remove();
        }
      }));
  }
}

test("proxy retains HTTP handshake evidence without target credentials", async () =>
  withCleanProxy(async () => {
    const fixture = await bundle();
    const forward = createServer();
    forward.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"));
    forward.listen(0, "127.0.0.1");
    await once(forward, "listening");
    process.env.HTTP_PROXY = `http://127.0.0.1:${(forward.address() as AddressInfo).port}`;
    let proxy;
    try {
      proxy = await startBrowserProxy("ws://browser-secret.invalid/private-token?key=secret-value", fixture.modulePath);
      const client = new WebSocket(proxy.endpoint);
      await once(client, "close");
      assert.match(proxy.getError()?.message, /Unexpected server response: 403/);
      assert.doesNotMatch(String(proxy.getError()?.stack), /browser-secret|private-token|secret-value/);
    } finally {
      await proxy?.close();
      await new Promise<void>((resolve) => forward.close(() => resolve()));
      await fixture.remove();
    }
  }));
