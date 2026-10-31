import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

const TEMPLATE = {
  id: "test-template",
  name: "qm-agent-test",
  team_id: "test-team",
  status: "ready",
  vcpu: 2,
  memory_mib: 2048,
  disk_mib: 8192,
  created_at: "2026-01-01T00:00:00Z",
};

async function builder(t: TestContext, existing = false) {
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = new URL(req.url!, "http://localhost").pathname;
    requests.push({ method: req.method!, path, body: body ? JSON.parse(body) : {} });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && path === "/templates") {
      res.end(JSON.stringify(existing ? [TEMPLATE] : []));
    } else if (req.method === "GET" && path === `/templates/${TEMPLATE.id}`) {
      res.end(JSON.stringify(TEMPLATE));
    } else if (req.method === "POST" && path === "/templates") {
      res.end(JSON.stringify({ ...TEMPLATE, status: "pending", build_id: "test-build" }));
    } else {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "Unexpected request" } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    run: (...args: string[]) =>
      promisify(execFile)(process.execPath, ["superserve/templates/qm-agent.ts", "--release", "test", ...args], {
        cwd: new URL("../", import.meta.url),
        env: {
          ...process.env,
          SUPERSERVE_API_KEY: "test-api-key",
          SUPERSERVE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        timeout: 10_000,
      }),
  };
}

test("agent template defaults to 8 vCPUs, 16 GiB memory, and 32 GiB disk", async (t) => {
  const b = await builder(t);
  await b.run();
  const creates = b.requests.filter((r) => r.method === "POST");
  assert.equal(creates.length, 1);
  assert.equal(creates[0]!.body.disk_mib, 32768);
  assert.equal(creates[0]!.body.vcpu, 8);
  assert.equal(creates[0]!.body.memory_mib, 16384);
});

for (const { flag, field, values } of [
  { flag: "vcpu", field: "vcpu", values: [2, 16] },
  { flag: "memory-mib", field: "memory_mib", values: [2048, 32768] },
  { flag: "disk-mib", field: "disk_mib", values: [8192, 65536] },
]) {
  for (const value of values) {
    test(`agent template honors --${flag} ${value}`, async (t) => {
      const b = await builder(t);
      await b.run(`--${flag}`, String(value));
      const creates = b.requests.filter((r) => r.method === "POST");
      assert.equal(creates.length, 1);
      const { vcpu, memory_mib, disk_mib } = creates[0]!.body;
      assert.deepEqual({ vcpu, memory_mib, disk_mib }, { vcpu: 8, memory_mib: 16384, disk_mib: 32768, [field]: value });
    });
  }

  for (const value of ["0", "-1", "1.5", "invalid"]) {
    test(`agent template rejects --${flag}=${value} before contacting the API`, async (t) => {
      const b = await builder(t);
      await assert.rejects(b.run(`--${flag}=${value}`), new RegExp(`--${flag} must be a positive integer`));
      assert.deepEqual(b.requests, []);
    });
  }
}

test("a ready template is reused without resizing or deleting it", async (t) => {
  const b = await builder(t, true);
  const result = await b.run("--vcpu", "8", "--memory-mib", "16384", "--disk-mib", "32768");
  assert.match(result.stdout, /already ready/);
  assert.match(result.stdout, /shape=2vcpu\/2048MiB\/8192MiB/);
  assert.ok(b.requests.every((r) => r.method === "GET"));
});
