import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import { buildModelRuntime } from "../src/harness/pi-harness.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";

async function listen(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("a gateway redirect to another origin is never followed, so the gateway key stays with the gateway", async (t) => {
  const leaked: Array<string | string[] | undefined> = [];
  const elsewhere = await listen(t, (req, res) => {
    leaked.push(req.headers["x-gateway-key"]);
    res.end();
  });
  let asked = 0;
  const url = await listen(t, (req, res) => {
    asked++;
    res.writeHead(307, { location: `${elsewhere}${req.url}` });
    res.end();
  });
  const runtime = await buildModelRuntime(
    {},
    {
      url,
      apiKey: "gateway-secret",
      apiKeyHeader: "x-gateway-key",
      models: { "claude-haiku-4-5": "router/haiku", "gpt-5.5": "router/gpt" },
    },
  );
  const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };
  for (const id of ["claude-haiku-4-5", "gpt-5.5"]) {
    const model = getRequiredModel(id, false);
    const simple = await runtime.streamSimple(model, context, { maxRetries: 0 }).result();
    const streamed = await runtime.stream(model, context, { maxRetries: 0 }).result();
    assert.equal(simple.stopReason, "error");
    assert.equal(streamed.stopReason, "error");
  }
  assert.equal(asked, 4);
  assert.deepEqual(leaked, []);
});
