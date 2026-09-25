import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMicrovmApi,
  createMicrovmClient,
  vmFetch,
  AwsApiError,
  type AwsMicrovmApi,
} from "../src/sandbox/aws-microvm-api.ts";

interface Recorded {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

function fakeFetch(
  reply: (rec: Recorded, n: number) => { status: number; body?: unknown; headers?: Record<string, string> },
): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const rec: Recorded = {
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      ...(init?.body ? { body: String(init.body) } : {}),
    };
    calls.push(rec);
    const r = reply(rec, calls.length - 1);
    const text = r.body === undefined ? "" : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const creds = async () => ({ accessKeyId: "AKIATEST", secretAccessKey: "secret" });

test("runMicrovm posts to the versioned path, signs as lambda, and parses the body", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({
    status: 200,
    body: { microvmId: "mvm-1", endpoint: "mvm-1.lambda-microvm.us-west-2.on.aws", state: "PENDING" },
  }));
  const api = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl });
  const res = await api.runMicrovm({
    imageIdentifier: "img",
    ingressNetworkConnectors: ["ing"],
    egressNetworkConnectors: ["egr"],
    maximumDurationInSeconds: 28800,
  });
  assert.equal(res.microvmId, "mvm-1");
  assert.equal(res.state, "PENDING");
  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://lambda.us-west-2.amazonaws.com/2025-09-09/microvms");
  assert.match(
    call.headers.authorization ?? "",
    /AWS4-HMAC-SHA256 Credential=AKIATEST\/.*\/us-west-2\/lambda\/aws4_request/,
  );
  const body = JSON.parse(call.body!);
  assert.deepEqual(body.ingressNetworkConnectors, ["ing"]);
  assert.equal(body.maximumDurationInSeconds, 28800);
});

test("createAuthToken extracts the X-aws-proxy-auth value", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({
    status: 200,
    body: { authToken: { "X-aws-proxy-auth": "TOK123" } },
  }));
  const api = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl });
  const tok = await api.createAuthToken("mvm-1", 30);
  assert.equal(tok, "TOK123");
  assert.equal(calls[0]!.url, "https://lambda.us-west-2.amazonaws.com/2025-09-09/microvms/mvm-1/auth-token");
  assert.deepEqual(JSON.parse(calls[0]!.body!), { allowedPorts: [{ allPorts: {} }], expirationInMinutes: 30 });
});

test("suspend/resume/terminate hit the right verbs and paths", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200 }));
  const api = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl });
  await api.suspend("m1");
  await api.resume("m1");
  await api.terminate("m1");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    ["POST /2025-09-09/microvms/m1/suspend", "POST /2025-09-09/microvms/m1/resume", "DELETE /2025-09-09/microvms/m1"],
  );
});

test("tryGetMicrovm maps a 404 to null but rethrows other errors", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 404, body: { message: "nope" } }));
  const api = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl });
  assert.equal(await api.tryGetMicrovm("gone"), null);

  const { fetchImpl: f500 } = fakeFetch(() => ({ status: 500, body: { message: "boom" } }));
  const api2 = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl: f500 });
  await assert.rejects(
    () => api2.tryGetMicrovm("x"),
    (e) => e instanceof AwsApiError && e.status === 500,
  );
});

test("waitForState polls getMicrovm until the target state", async () => {
  const states = ["PENDING", "PENDING", "RUNNING"];
  const { fetchImpl, calls } = fakeFetch((_r, n) => ({
    status: 200,
    body: { microvmId: "m1", state: states[Math.min(n, states.length - 1)] },
  }));
  const api = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl });
  const res = await api.waitForState("m1", "RUNNING", { intervalMs: 1 });
  assert.equal(res.state, "RUNNING");
  assert.equal(calls.length, 3);
});

test("waitForState throws if the microVM terminates while waiting", async () => {
  const { fetchImpl } = fakeFetch(() => ({
    status: 200,
    body: { microvmId: "m1", state: "TERMINATED", stateReason: "capped" },
  }));
  const api = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl });
  await assert.rejects(() => api.waitForState("m1", "RUNNING", { intervalMs: 1 }), /terminated while waiting/);
});

test("findImage filters the list by name", async () => {
  const { fetchImpl } = fakeFetch(() => ({
    status: 200,
    body: {
      items: [
        { name: "other", imageArn: "a", state: "CREATED", latestActiveImageVersion: "1.0" },
        { name: "mine", imageArn: "b", state: "CREATED", latestActiveImageVersion: "2.0" },
      ],
    },
  }));
  const api = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl });
  const img = await api.findImage("mine");
  assert.equal(img?.imageArn, "b");
  assert.equal(await api.findImage("absent"), null);
});

test("vmFetch sends the proxy auth + port headers to the MicroVM endpoint", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
  const res = await vmFetch("mvm-1.example.on.aws", "TOK", "/health", { fetchImpl, port: 8080 });
  assert.equal(res.status, 200);
  assert.equal(calls[0]!.url, "https://mvm-1.example.on.aws/health");
  assert.equal(calls[0]!.headers["x-aws-proxy-auth"], "TOK");
  assert.equal(calls[0]!.headers["x-aws-proxy-port"], "8080");
});

test(
  "waitDaemon: a sustained gateway 429 is throttle, not daemon failure — no deadline poll-out",
  { timeout: 15_000 },
  async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 429 }));
    const api = { createAuthToken: async () => "tok" } as unknown as AwsMicrovmApi;
    const client = createMicrovmClient(api, { agentPort: 8080, tokenTtlMinutes: 30, fetchImpl });
    await client.waitDaemon("mvm-1", "mvm-1.example.on.aws");
    assert.equal(calls.length, 3, "a brief throttle is ridden out, a sustained one presumes the body alive");
  },
);

test("waitDaemon: a transient 429 blip still proves readiness on the next probe", { timeout: 15_000 }, async () => {
  const { fetchImpl, calls } = fakeFetch((_r, n) => ({ status: n === 0 ? 429 : 200 }));
  const api = { createAuthToken: async () => "tok" } as unknown as AwsMicrovmApi;
  const client = createMicrovmClient(api, { agentPort: 8080, tokenTtlMinutes: 30, fetchImpl });
  await client.waitDaemon("mvm-1", "mvm-1.example.on.aws");
  assert.equal(calls.length, 2, "the blip is ridden out and the 200 proves the daemon");
});

test("readiness reuses only the supplied observation and checks again on the next call", async () => {
  let reads = 0;
  const api = {
    getMicrovm: async (id: string) => {
      reads++;
      return { microvmId: id, state: "TERMINATED" };
    },
  } as AwsMicrovmApi;
  const client = createMicrovmClient(api, { agentPort: 8080, tokenTtlMinutes: 30 });
  await client.ensureRunning("one", "endpoint", { microvmId: "one", state: "RUNNING" });
  assert.equal(reads, 0);
  await assert.rejects(client.ensureRunning("one", "endpoint"), /TERMINATED/);
  assert.equal(reads, 1);
  await assert.rejects(client.ensureRunning("one", "endpoint", { microvmId: "two", state: "RUNNING" }), /another body/);
});

test("control-plane reads retry throttling and outages, and failures carry the AWS request id", async () => {
  const replies = [
    { status: 429, body: { message: "Rate exceeded" }, headers: { "retry-after": "0" } },
    { status: 503, body: { message: "unavailable" }, headers: { "retry-after": "0" } },
    { status: 200, body: { microvmId: "mvm-1", endpoint: "e", state: "RUNNING" } },
  ];
  const { fetchImpl, calls } = fakeFetch((_rec, n) => replies[n]!);
  const api = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl });
  assert.equal((await api.getMicrovm("mvm-1")).state, "RUNNING");
  assert.equal(calls.length, 3);

  const failing = fakeFetch(() => ({
    status: 500,
    body: { message: "boom" },
    headers: { "x-amzn-requestid": "aws-req-1" },
  }));
  const api2 = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl: failing.fetchImpl });
  await assert.rejects(api2.getMicrovm("mvm-1"), (e: unknown) => {
    assert.ok(e instanceof AwsApiError);
    assert.equal(e.status, 500);
    assert.match(e.message, /-> 500: boom \[request id aws-req-1\]$/);
    return true;
  });
  assert.equal(failing.calls.length, 4, "an idempotent read is retried until attempts run out");
});

test("runMicrovm retries a throttled create but never an ambiguous server error", async () => {
  const throttled = fakeFetch((_rec, n) =>
    n === 0
      ? { status: 429, body: { message: "Rate exceeded" }, headers: { "retry-after": "0" } }
      : { status: 200, body: { microvmId: "mvm-2", endpoint: "e", state: "PENDING" } },
  );
  const api = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl: throttled.fetchImpl });
  const run = { imageIdentifier: "img", ingressNetworkConnectors: [], egressNetworkConnectors: [] };
  assert.equal((await api.runMicrovm(run)).microvmId, "mvm-2");
  assert.equal(throttled.calls.length, 2);

  const broken = fakeFetch(() => ({ status: 502, body: { message: "bad gateway" } }));
  const api2 = createMicrovmApi({ region: "us-west-2", credentials: creds, fetchImpl: broken.fetchImpl });
  await assert.rejects(api2.runMicrovm(run), /-> 502: bad gateway/);
  assert.equal(broken.calls.length, 1);
});
