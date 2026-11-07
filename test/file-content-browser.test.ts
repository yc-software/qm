import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import pg from "pg";
import { createServer } from "../src/api/server.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { fileArtifactId } from "../src/files/file-artifact-store.ts";
import { scopeId } from "../src/types.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp, stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";

const SIGNING = "file-content-browser-signing-secret-0123";
const config = testConfig({ signingSecret: SIGNING });
const built = stopAtEnd(buildApp(config));
const ids: Record<string, string> = {};

async function put(
  key: string,
  owner: string,
  name: string,
  mimetype: string,
  data: string | Buffer,
  createdAt?: number,
) {
  const id = fileArtifactId(`${key}-${Date.now()}`, "out", 0);
  ids[key] = id;
  await built.files.put({
    id,
    ownerScopeId: scopeId("personal", owner),
    createdBy: owner,
    name,
    path: `artifacts/${id}/${name}`,
    mimetype,
    data: typeof data === "string" ? Buffer.from(data) : data,
    direction: "out",
    ...(createdAt ? { createdAt } : {}),
  });
}

await put("html", "alice", "x.html", "text/html", "<script>fetch('/api/keychain')</script>");
await put("pdf", "alice", "x.pdf", "application/pdf", "%PDF-1.4 fake");
await put("png", "alice", "pic.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
await put("bobs", "bob", "bob.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
await put("olderCsv", "alice", "interview-list.csv", "text/csv", "old", Date.now() - 60_000);
await put("csv", "alice", "interview-list.csv", "text/csv", "new");
await put("bobCsv", "bob", "interview-list.csv", "text/csv", "bob");

await put("smuggled", "alice", "x.txt", "text/plain, text/html", "<script>fetch('/api/keychain')</script>");

const PLAYGROUND_HTML = "<!doctype html><button>Go</button><script>void 0</script>";
await put("playground", "alice", "pg.html", "text/html", PLAYGROUND_HTML);

const app = {
  ...built.app,
  openFileForViewer: async (id: string, viewer: string) =>
    id === "cut-off"
      ? {
          name: "cut.pdf",
          mimetype: "application/pdf",
          sizeBytes: 1_000_000,
          stream: Readable.from(
            (async function* () {
              yield Buffer.alloc(64 * 1024, 120);
              await new Promise((resolve) => setTimeout(resolve, 20));
              throw new Error("storage reset");
            })(),
          ),
        }
      : built.app.openFileForViewer(id, viewer),
};

async function frontDoor(t: TestContext, deps: Partial<ServerDeps> = {}): Promise<string> {
  const core = createServer(app, { ...serverDeps(config, built), ...browserSessionDeps, ...deps });
  const portal = createHttpServer((req, res) => {
    res.setHeader("x-frame-options", "DENY");
    core.emit("request", req, res);
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    portal.close();
    portal.closeAllConnections();
  });
  return `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
}

const asAlice = { headers: { cookie: browserSessionCookie("alice") } };

test("inline file artifacts are sandboxed to an opaque origin (no same-origin XSS)", async (t) => {
  const base = await frontDoor(t);
  const r = await fetch(`${base}/api/files/${ids.html}/content`, asAlice);
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^sandbox\b/, "served under a CSP sandbox");
  assert.ok(!/allow-same-origin/.test(csp), "the sandbox never grants same-origin");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(csp, /frame-ancestors 'self'/, "our own surfaces may unfurl it inline");
  assert.equal(r.headers.get("x-frame-options"), null, "a blanket DENY would defeat frame-ancestors");
});

test("inert types (PDF) are served without a CSP sandbox so the browser viewer renders them", async (t) => {
  const base = await frontDoor(t);
  const r = await fetch(`${base}/api/files/${ids.pdf}/content`, asAlice);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'self'");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("every non-PDF type is sandboxed, including a stored mimetype that names several types", async (t) => {
  const base = await frontDoor(t);
  const image = await fetch(`${base}/api/files/${ids.png}/content`, asAlice);
  assert.match(image.headers.get("content-security-policy") ?? "", /^sandbox\b/);
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  await pool.query("UPDATE file_artifacts SET mimetype = 'application/pdf, text/html' WHERE id = $1", [ids.smuggled]);
  await pool.end();
  const smuggled = await fetch(`${base}/api/files/${ids.smuggled}/content`, asAlice);
  assert.match(smuggled.headers.get("content-security-policy") ?? "", /^sandbox\b/);
});

test("a cosmetic trailing filename on the content URL serves the same file", async (t) => {
  const base = await frontDoor(t);
  const r = await fetch(`${base}/api/files/${ids.pdf}/content/Upstream%20Batch%20Review.pdf`, asAlice);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'self'");
});

test("with a deploy apps domain, file frames also name it: the app shell's chat panel is an ancestor", async (t) => {
  const base = await frontDoor(t, { deployAppsDomain: "apps.test" });
  const r = await fetch(`${base}/api/files/${ids.html}/content`, asAlice);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'self' \*\.apps\.test/);
  assert.equal(r.headers.get("x-frame-options"), null);
});

test("file content is served only to a signed-in viewer who can see the file", async (t) => {
  const base = await frontDoor(t);
  const r = await fetch(`${base}/api/files/${ids.png}/content`, asAlice);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /image\/png/);
  assert.equal((await r.arrayBuffer()).byteLength, 4);
  assert.equal((await fetch(`${base}/api/files/${ids.png}/content`)).status, 401);
  const other = await fetch(`${base}/api/files/${ids.bobs}/content`, asAlice);
  assert.equal(other.status, 404);
  assert.equal(((await other.json()) as { error?: string }).error, "not_found");
  assert.equal((await fetch(`${base}/api/files/${ids.bobs}/content?viewer=bob`, asAlice)).status, 403);
  const missing = await fetch(`${base}/api/files/missing/content`, asAlice);
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error?: string }).error, "not_found");
});

test("playground content is same-origin frameable but isolated from network and parent origin", async (t) => {
  const base = await frontDoor(t);
  const response = await fetch(`${base}/api/playgrounds/${ids.playground}`, asAlice);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), PLAYGROUND_HTML);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^sandbox allow-scripts/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("playground source is plain text and non-HTML artifacts are refused", async (t) => {
  const base = await frontDoor(t);
  const source = await fetch(`${base}/api/playgrounds/${ids.playground}?source=1`, asAlice);
  assert.match(source.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(await source.text(), PLAYGROUND_HTML);
  assert.equal((await fetch(`${base}/api/playgrounds/${ids.png}`, asAlice)).status, 415);
});

test("sandbox markdown download resolves the newest authorized file-library item by name", async (t) => {
  const base = await frontDoor(t);
  const response = await fetch(`${base}/api/files/by-name/content?name=interview-list.csv`, {
    ...asAlice,
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `/api/files/${ids.csv}/content`);
});

test("sandbox markdown download stays unavailable when no visible file matches", async (t) => {
  const base = await frontDoor(t);
  const response = await fetch(`${base}/api/files/by-name/content?name=bob.png`, { ...asAlice, redirect: "manual" });
  assert.equal(response.status, 404);
});

test("a file body cut off mid-stream fails only that response and leaves the server serving", async (t) => {
  const base = await frontDoor(t);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  t.after(() => process.off("uncaughtException", onUncaught));
  const r = await fetch(`${base}/api/files/cut-off/content`, asAlice);
  assert.equal(r.status, 200);
  await assert.rejects(r.arrayBuffer(), "the truncated body surfaces to the client as a failed download");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(uncaught, [], "no uncaught exception escapes the content route");
  const ok = await fetch(`${base}/api/files/${ids.pdf}/content`, asAlice);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "%PDF-1.4 fake");
});
