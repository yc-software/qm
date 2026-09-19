import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createSdkSuperserveClient, SuperserveSandboxGoneError } from "../src/sandbox/superserve-client.ts";

const SANDBOX = {
  id: "test-sandbox",
  name: "test-sandbox",
  status: "active",
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  access_token: "test-access-token",
};

function mockApi(t: TestContext, respond: (url: URL, init?: RequestInit) => Response | Promise<Response>): void {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/activate")) return Response.json(SANDBOX);
    return respond(url, init);
  });
}

const connect = () =>
  createSdkSuperserveClient({ apiKey: "test-api-key", baseUrl: "https://sandbox.example.com" }).connect(SANDBOX.id);

function stream(events: object[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

function apiError(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

test("SDK command results retain terminal errors after streamed stderr", async (t) => {
  mockApi(t, () =>
    stream([{ stderr: "prior warning\n" }, { finished: true, exit_code: 124, error: "command timed out" }]),
  );
  const result = await (await connect()).run("sleep 100");
  assert.equal(result.stderr, "prior warning\ncommand timed out");
  assert.equal(result.exitCode, 124);
});

test("SDK command results cap each stream on UTF-8 boundaries and report truncation", async (t) => {
  mockApi(t, () =>
    stream([
      { stdout: "漢漢", stderr: "warning" },
      { finished: true, exit_code: 1, error: "terminal failure" },
    ]),
  );
  const result = await (await connect()).run("command", { maxOutputBytes: 4 });
  assert.deepEqual(result, { stdout: "漢", stderr: "warn", exitCode: 1, truncated: true });
});

test("SDK terminal errors alone are included in truncation accounting", async (t) => {
  mockApi(t, () => stream([{ finished: true, exit_code: 1, error: "terminal failure" }]));
  const result = await (await connect()).run("command", { maxOutputBytes: 4 });
  assert.deepEqual(result, { stdout: "", stderr: "term", exitCode: 1, truncated: true });
});

test("SDK command transport errors containing HTTP status digits do not mark sandboxes gone", async (t) => {
  mockApi(t, () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:4100");
  });
  await assert.rejects((await connect()).run("true"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "SandboxError");
    assert.match(error.message, /ECONNREFUSED/);
    return true;
  });
});

for (const status of [404, 410]) {
  test(`SDK HTTP ${status} command errors mark sandboxes gone independently of message wording`, async (t) => {
    mockApi(t, () => apiError(status, "Sandbox has expired"));
    await assert.rejects((await connect()).run("true"), SuperserveSandboxGoneError);
  });
}

test("SDK missing file returns null while its sandbox remains active", async (t) => {
  mockApi(t, (url) => (url.pathname === "/files" ? apiError(404, "No such file") : Response.json(SANDBOX)));
  assert.equal(await (await connect()).readFileBytes("/missing"), null);
});

for (const status of ["deleted", "failed", "absent"]) {
  test(`SDK file 404 distinguishes sandbox state ${status} from a missing file`, async (t) => {
    mockApi(t, (url) => {
      if (url.pathname === "/files") return apiError(404, "No such file");
      return status === "absent" ? apiError(404, "Missing resource") : Response.json({ ...SANDBOX, status });
    });
    await assert.rejects((await connect()).readFileBytes("/missing"), SuperserveSandboxGoneError);
  });
}

test("SDK HTTP 410 file errors mark sandboxes gone", async (t) => {
  mockApi(t, () => apiError(410, "Sandbox has expired"));
  await assert.rejects((await connect()).readFileBytes("/file"), SuperserveSandboxGoneError);
});

test("SDK file validation errors containing 404 are preserved", async (t) => {
  mockApi(t, (url) => {
    assert.equal(url.pathname, "/files");
    return apiError(400, "Cannot read directory /root/404");
  });
  await assert.rejects((await connect()).readFileBytes("/root/404"), { name: "ValidationError" });
});

test("command truncation preserves the original UTF-8 prefix across later chunks and terminal errors", async (t) => {
  mockApi(t, () =>
    stream([
      { stdout: "漢漢", stderr: "漢漢" },
      { stdout: "x", stderr: "y" },
      { finished: true, exit_code: 7, error: "z" },
    ]),
  );
  const result = await (await connect()).run("command", { maxOutputBytes: 4 });
  assert.deepEqual(result, { stdout: "漢", stderr: "漢", exitCode: 7, truncated: true });
});
