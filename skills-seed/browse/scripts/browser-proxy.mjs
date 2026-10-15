import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { formatBrowserError } from "./browser-errors.mjs";

export async function startBrowserProxy(cdpUrl, modulePath) {
  const { ws, wsServer, HttpsProxyAgent, getProxyForUrl } = createRequire(modulePath)("./lib/utilsBundle.js");
  let target = cdpUrl;
  let destination;
  try {
    destination = new URL(target);
  } catch {
    throw new Error("Browser endpoint is not a valid URL");
  }
  if (["http:", "https:"].includes(destination.protocol)) {
    if (!destination.pathname.endsWith("/")) destination.pathname += "/";
    destination.pathname += "json/version/";
    let response;
    try {
      response = await fetch(destination, { signal: AbortSignal.timeout(30000) });
    } catch (error) {
      throw safeFailure("Browser WebSocket discovery failed", error, [
        cdpUrl,
        destination.href,
        getProxyForUrl(destination.href),
      ]);
    }
    if (!response.ok) throw new Error(`Browser WebSocket discovery failed: HTTP ${response.status}`);
    try {
      target = (await response.json()).webSocketDebuggerUrl;
      destination = new URL(target);
    } catch {
      throw new Error("Browser discovery did not return a valid WebSocket URL");
    }
  }
  if (!["ws:", "wss:"].includes(destination.protocol)) throw new Error("Browser endpoint is not a WebSocket URL");
  destination.protocol = destination.protocol === "wss:" ? "https:" : "http:";
  const proxy = getProxyForUrl(destination.href);
  if (!proxy)
    return {
      endpoint: target,
      getError: (error) => error && safeFailure("Browser WebSocket transport failed", error, [target, proxy]),
      async close() {},
    };
  const agent = new HttpsProxyAgent(proxy);
  let failure;
  const record = (error) => {
    failure ??= safeFailure("Browser WebSocket transport failed", error, [target, proxy]);
  };
  const path = `/${randomUUID()}`;
  const server = new wsServer({ host: "127.0.0.1", port: 0, path, maxPayload: 256 * 1024 * 1024 });
  const connections = new Set();
  server.on("connection", (client) => {
    const upstream = new ws(target, { agent, handshakeTimeout: 30000, maxPayload: 256 * 1024 * 1024 });
    connections.add(client);
    connections.add(upstream);
    for (const socket of [client, upstream]) socket.once("close", () => connections.delete(socket));
    const terminate = () => {
      client.terminate();
      upstream.terminate();
    };
    for (const [source, destination] of [
      [client, upstream],
      [upstream, client],
    ]) {
      source.once("error", (error) => {
        record(error);
        terminate();
      });
      source.once("close", terminate);
      source.on("message", (data, binary) => {
        source.pause();
        const send = () =>
          destination.send(data, { binary }, (error) => {
            if (error) {
              record(error);
              terminate();
            } else source.resume();
          });
        if (destination.readyState === ws.CONNECTING) destination.once("open", send);
        else send();
      });
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    server.close();
    agent?.destroy();
    throw error;
  }
  let closing;
  return {
    endpoint: `ws://127.0.0.1:${server.address().port}${path}`,
    getError: (error) =>
      failure || (error && safeFailure("Browser WebSocket transport failed", error, [target, proxy])),
    close() {
      return (closing ??= new Promise((resolve, reject) => {
        for (const socket of connections) socket.terminate();
        server.close((error) => {
          agent?.destroy();
          if (error) reject(error);
          else resolve();
        });
      }));
    },
  };
}

function safeFailure(message, error, privateValues) {
  return new Error(`${message}: ${formatBrowserError(error, privateValues)}`);
}
