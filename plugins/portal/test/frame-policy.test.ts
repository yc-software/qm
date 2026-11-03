import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { proxyToDeployment, proxyToSurface } from "../src/proxy.ts";
import { verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";
import { canonicalPayload, signRequest } from "../../chassis/src/source-auth-sign.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
let lastDeployment: IncomingMessage | null = null;
const upstream = createServer((req: IncomingMessage, res) => {
  if ((req.url ?? "").startsWith("/d/")) lastDeployment = req;
  const csp = (req.url ?? "").includes("commas")
    ? "default-src 'self', frame-ancestors 'self'"
    : "sandbox allow-scripts; frame-ancestors 'self'";
  if ((req.url ?? "").includes("no-policy")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end("{}");
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp });
  res.end("<p>hi</p>");
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const fronts: ReturnType<typeof createServer>[] = [];

function front(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const s = createServer((req, res) => {
    res.setHeader("x-frame-options", "DENY");
    handle(req, res);
  });
  fronts.push(s);
  return new Promise((r) => s.listen(0, () => r(`http://localhost:${(s.address() as AddressInfo).port}`)));
}

const surfaceBase = await front((req, res) =>
  proxyToSurface(req, res, {
    tenant: TENANT,
    upstreamBase: upstreamUrl,
    forwardPath: req.url ?? "/",
    search: "",
    cookieName: "webuiuser",
    principal: "alice",
  }),
);

const deploymentBase = await front((req, res) =>
  proxyToDeployment(req, res, {
    tenant: TENANT,
    coreBase: upstreamUrl,
    id: "app1",
    subPath: req.url ?? "/",
    search: "",
    principal: "alice",
    signingSecret: "frame-policy-test-secret",
    identitySecret: "frame-policy-identity-secret",
  }),
);

test.after(() => {
  upstream.close();
  for (const s of fronts) s.close();
});

test("a first-party surface that declares frame-ancestors sheds the blanket DENY", async () => {
  const r = await fetch(`${surfaceBase}/api/files/f1/content/demo.html`);
  assert.equal(r.headers.get("x-frame-options"), null);
});

test("frame-ancestors after a comma-joined duplicate CSP header still counts", async () => {
  const r = await fetch(`${surfaceBase}/commas`);
  assert.equal(r.headers.get("x-frame-options"), null);
});

test("a surface with no frame policy of its own keeps the DENY", async () => {
  const r = await fetch(`${surfaceBase}/no-policy`);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
});

test("deployed app content never dictates the portal's frame policy, however it answers", async () => {
  const r = await fetch(`${deploymentBase}/index.html`);
  assert.equal(r.headers.get("x-frame-options"), "DENY", "agent-authored content cannot make the portal framable");
});

test("a deployment request carries its tenant in the signed header and the minted identity", async () => {
  await fetch(`${deploymentBase}/index.html`);
  const headers = lastDeployment?.headers ?? {};
  assert.equal(headers["x-qm-tenant"], TENANT);
  assert.equal(
    headers["x-signature"],
    signRequest(
      "frame-policy-test-secret",
      Number(headers["x-timestamp"]),
      canonicalPayload("GET", lastDeployment?.url ?? "", "alice", TENANT),
    ),
  );
  const identity = verifyPortalIdentity(
    String(headers["x-portal-identity"]),
    "frame-policy-identity-secret",
    Date.now(),
  );
  assert.equal(identity?.t, TENANT);
  assert.equal(identity?.p, "alice");
});
