import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ECSClient } from "@aws-sdk/client-ecs";
import { createFlyTunnelManager } from "../src/deploy/fly-tunnel-manager.ts";
import type { FlyPeerClaim } from "../src/deploy/fly-peer-claims.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

function readTunnelIdentity(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let body = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => socket.destroy(new Error("Tunnel response timed out")));
    socket.on("data", (chunk: string) => (body += chunk));
    socket.once("end", () => resolve(body));
    socket.once("error", reject);
  });
}

test("tenant Fly managers allocate distinct live ports and stop independently", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ TaskARN: "task", Cluster: "cluster", LaunchType: "FARGATE" })),
  );
  t.mock.method(ECSClient.prototype, "send", async () => ({
    tasks: [{ taskArn: "task", lastStatus: "RUNNING" }],
  }));
  const directory = await mkdtemp(join(tmpdir(), "qm-fly-tunnel-test-"));
  const executable = join(directory, "wireproxy");
  await writeFile(
    executable,
    `#!${process.execPath}
const { readFileSync } = require("node:fs");
const { createServer } = require("node:net");
const config = readFileSync(process.argv[process.argv.indexOf("-c") + 1], "utf8");
const port = Number(config.match(/BindAddress = 127\\.0\\.0\\.1:(\\d+)/)[1]);
const tenant = config.match(/Tenant = (\\w+)/)[1];
const server = createServer((socket) => {
  socket.on("error", () => {});
  socket.end(tenant);
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
    { mode: 0o700 },
  );
  const managers = ["alpha", "bravo"].map((tenant) =>
    createFlyTunnelManager({
      peers: [{ id: `${tenant}-peer`, config: `[Interface]\nTenant = ${tenant}\n` }],
      claims: createMemoryMap<FlyPeerClaim>(),
      metadataUri: "http://169.254.170.2/v4/test",
      executable,
    }),
  );
  const [alpha, bravo] = managers;
  assert.ok(alpha && bravo);
  try {
    const [alphaPort, bravoPort] = await Promise.all([alpha.ensure(), bravo.ensure()]);
    assert.notEqual(alphaPort, bravoPort);
    assert.deepEqual(await Promise.all([readTunnelIdentity(alphaPort), readTunnelIdentity(bravoPort)]), [
      "alpha",
      "bravo",
    ]);
    assert.deepEqual(await Promise.all([alpha.ensure(), bravo.ensure()]), [alphaPort, bravoPort]);
    await alpha.stop();
    await assert.rejects(readTunnelIdentity(alphaPort), { code: "ECONNREFUSED" });
    await assert.rejects(alpha.ensure(), /stopped/);
    assert.equal(await readTunnelIdentity(bravoPort), "bravo");
    assert.equal(await bravo.ensure(), bravoPort);
    await bravo.stop();
    await assert.rejects(readTunnelIdentity(bravoPort), { code: "ECONNREFUSED" });
  } finally {
    await Promise.all(managers.map((manager) => manager.stop()));
    await rm(directory, { recursive: true, force: true });
  }
});
