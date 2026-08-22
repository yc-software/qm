import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const SCOPES_BODY = { scopes: [{ id: "org:acme", label: "Org", kind: "org" }] };

const core = createServer((req: IncomingMessage, res) => {
  if (req.method === "GET" && (req.url ?? "").startsWith("/v1/admin/scopes")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify(SCOPES_BODY));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-csp-test-secret";

const { server, cspScriptHash } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as AddressInfo).port;

test.after(() => {
  server.close();
  if (core.listening) core.close();
});

function get(
  path: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("cspScriptHash matches what browsers compute for CRLF/CR-normalized script text", () => {
  const lf = "let x = 1;\nlet y = 2;\n";
  const crlf = "let x = 1;\r\nlet y = 2;\r\n";
  const cr = "let x = 1;\rlet y = 2;\r";

  const browserHash = createHash("sha256").update(lf).digest("base64");

  assert.equal(cspScriptHash(lf), browserHash);
  // A Windows (CRLF) or classic-Mac (CR) checkout must hash to the same value
  // the browser computes over the LF-normalized script (#552).
  assert.equal(cspScriptHash(crlf), browserHash);
  assert.equal(cspScriptHash(cr), browserHash);
});

test("served CSP carries the hash of the LF-normalized inline script", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);

  const csp = r.headers["content-security-policy"];
  assert.ok(typeof csp === "string", "CSP header present");

  const scriptStart = r.body.indexOf("<script>");
  const scriptEnd = r.body.indexOf("</script>", scriptStart);
  assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "inline script present in served HTML");
  const script = r.body.slice(scriptStart + "<script>".length, scriptEnd);

  // This is exactly what a browser does before checking the CSP source.
  const browserHash = createHash("sha256").update(script.replace(/\r\n?/g, "\n")).digest("base64");
  assert.ok(
    csp.includes(`sha256-${browserHash}`),
    `served CSP must allow the inline script; CSP=${csp} expected sha256-${browserHash}`,
  );
});
