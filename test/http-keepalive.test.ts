import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { createHttpServer } from "../plugins/chassis/src/http.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";

const factories: Record<string, () => Server> = {
  core: () => createInsecureTestServer({} as App),
  plugin: () => createHttpServer((_req, res) => res.end("ok")),
};

for (const [name, createServer] of Object.entries(factories)) {
  test(
    `${name} reuses an idle connection beyond Node's default timeout`,
    { timeout: 15_000, concurrency: true },
    async () => {
      const server = createServer();
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const send = () =>
          new Promise<{ status: number | undefined; reused: boolean }>((resolve, reject) => {
            const req = request(
              { host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/healthz", agent },
              (res) => {
                res.resume();
                res.once("end", () => resolve({ status: res.statusCode, reused: req.reusedSocket }));
                res.once("error", reject);
              },
            );
            req.once("error", reject);
            req.setTimeout(2_000, () => req.destroy(new Error("request timed out")));
            req.end();
          });
        assert.equal((await send()).status, 200);
        await sleep(6_200);
        const second = await send();
        assert.equal(second.status, 200);
        assert.equal(second.reused, true);
      } finally {
        agent.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
}
