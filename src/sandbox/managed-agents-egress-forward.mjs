import { request } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, listenPort] = process.argv.slice(2);
const upstreamProxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";
const bare = (host) => host.replace(/^\[|\]$/g, "");
const log = (error) => console.error(`egress forwarder: ${error.message}`);
const refuse = (client, error) => {
  log(error);
  client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\negress forwarder: ${error.message}\n`);
};

function open(host, port, onOpen, onFail) {
  if (!upstreamProxy) {
    const direct = net.connect(port, host, () => onOpen(direct));
    direct.on("error", onFail);
    return direct;
  }
  const upstream = new URL(upstreamProxy);
  const credentials = upstream.username
    ? `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`
    : "";
  const tunnel = request({
    host: bare(upstream.hostname),
    port: Number(upstream.port) || 80,
    method: "CONNECT",
    path: `${host}:${port}`,
    headers: {
      host: `${host}:${port}`,
      ...(credentials ? { "proxy-authorization": `Basic ${Buffer.from(credentials).toString("base64")}` } : {}),
    },
  });
  tunnel.on("connect", (response, socket, head) => {
    if (response.statusCode !== 200) {
      socket.destroy();
      onFail(new Error(`upstream proxy answered CONNECT with ${response.statusCode} ${response.statusMessage}`));
      return;
    }
    if (head.length) socket.unshift(head);
    onOpen(socket);
  });
  tunnel.on("error", onFail);
  tunnel.end();
  return tunnel;
}

const server = net.createServer((client) => {
  client.pause();
  let opened = false;
  let pending;
  let tunnel;
  client.on("error", () => client.destroy());
  client.on("close", () => (tunnel ?? pending)?.destroy());
  let proxy;
  try {
    proxy = new URL(readFileSync(join(dir, "proxy"), "utf8").trim());
  } catch (error) {
    refuse(client, error);
    return;
  }
  const secure = proxy.protocol === "https:";
  const host = bare(proxy.hostname);
  pending = open(
    host,
    Number(proxy.port) || (secure ? 443 : 80),
    (socket) => {
      opened = true;
      tunnel = secure ? tls.connect({ socket, servername: host }) : socket;
      if (client.destroyed) {
        tunnel.destroy();
        return;
      }
      tunnel.on("error", (error) => {
        log(error);
        client.destroy();
      });
      client.pipe(tunnel);
      tunnel.pipe(client);
    },
    (error) => {
      if (!opened) refuse(client, error);
    },
  );
});

server.listen(Number(listenPort), "127.0.0.1", () => writeFileSync(join(dir, "pid"), String(process.pid)));
