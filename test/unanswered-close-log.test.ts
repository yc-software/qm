import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { test } from "node:test";
import { format } from "node:util";
import { logUnansweredCloses } from "../plugins/chassis/src/http.ts";

async function capture(run: (port: number) => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(format(...args));
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/drop")) return void req.socket.destroy();
    if (req.url === "/unread") return void res.end("answered without reading the body");
    if (req.url === "/too-large") {
      res.writeHead(413, { connection: "close" });
      return void res.end();
    }
    res.end("ok");
  });
  server.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", () => undefined);
    socket.on("end", () => socket.end());
  });
  logUnansweredCloses(server, "test");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    console.warn = warn;
    await new Promise((resolve) => server.close(resolve));
  }
  return lines;
}

function exchange(port: number, requests: string[]): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
      const next = requests.shift();
      if (next) socket.write(next);
      else socket.end();
    });
    socket.on("close", () => resolve(received));
    socket.write(requests.shift() ?? "");
  });
}

test("a connection dropped mid-request is logged with the request it was serving", async () => {
  const lines = await capture(async (port) => {
    await exchange(port, [
      "GET /ok HTTP/1.1\r\nHost: x\r\n\r\n",
      "POST /drop?secret=1 HTTP/1.1\r\nHost: x\r\nX-Amzn-Trace-Id: Root=1-abc\r\nContent-Length: 0\r\n\r\n",
    ]);
  });
  assert.equal(lines.length, 1);
  assert.match(
    lines[0]!,
    /\[http\] test connection closed before answering: request=POST \/drop after \d+ms trace=Root=1-abc/,
  );
  assert.match(lines[0]!, /served=1 /);
  assert.doesNotMatch(lines[0]!, /secret/);
});

test("bytes that never became a request are logged as unanswered", async () => {
  const lines = await capture(async (port) => {
    await new Promise<void>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write("GET /partial HTTP/1.1\r\nHost:");
        setTimeout(() => socket.destroy(), 30);
      });
      socket.on("close", () => resolve());
    });
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /request=none parsed unanswered_bytes=\d+ .* error=HPE_INVALID_EOF_STATE /);
});

test("answered keep-alive requests and clean closes log nothing", async () => {
  const lines = await capture(async (port) => {
    const received = await exchange(port, ["GET /a HTTP/1.1\r\nHost: x\r\n\r\n", "GET /b HTTP/1.1\r\nHost: x\r\n\r\n"]);
    assert.equal(received.match(/HTTP\/1.1 200/g)?.length, 2);
  });
  assert.deepEqual(lines, []);
});

test("upgraded connections and requests answered before their body was read log nothing", async () => {
  const lines = await capture(async (port) => {
    await new Promise<void>((resolve) => {
      const socket = connect(port, "127.0.0.1", () =>
        socket.write("GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"),
      );
      socket.once("data", () => {
        socket.write("frame bytes after the upgrade");
        setTimeout(() => socket.end(), 20);
      });
      socket.on("close", () => resolve());
    });
    await new Promise<void>((resolve) => {
      const socket = connect(port, "127.0.0.1", () =>
        socket.write("POST /too-large HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\nstart of a large body"),
      );
      socket.once("data", () => {
        socket.write("more body bytes");
        setTimeout(() => socket.destroy(), 20);
      });
      socket.on("close", () => resolve());
    });
  });
  assert.deepEqual(lines, []);
});

test("a connection keeps being watched after a request answered without reading its body", async () => {
  const lines = await capture(async (port) => {
    await exchange(port, [
      "POST /unread HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello",
      "GET /drop HTTP/1.1\r\nHost: x\r\n\r\n",
    ]);
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /request=GET \/drop after \d+ms .* served=1 /);
});
