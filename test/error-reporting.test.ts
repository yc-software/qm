import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { traceStatus } from "../plugins/chassis/src/timing.ts";

async function runReporting(body: string, enabled = true, env: Record<string, string> = {}) {
  const events: Record<string, any>[] = [];
  const transactions: Record<string, any>[] = [];
  const headers: Record<string, any>[] = [];
  const outbound: Record<string, unknown>[] = [];
  const collector = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const lines = Buffer.concat(chunks).toString().split("\n");
    if (req.url?.includes("outbound")) {
      outbound.push(req.headers);
      res.end("{}");
      return;
    }
    if (lines[0]) headers.push(JSON.parse(lines[0]));
    for (let i = 1; i + 1 < lines.length; i += 2) {
      const type = JSON.parse(lines[i]!).type;
      if (type === "event") events.push(JSON.parse(lines[i + 1]!));
      if (type === "transaction") transactions.push(JSON.parse(lines[i + 1]!));
    }
    res.end("{}");
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  const address = collector.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import * as Sentry from '@sentry/node';
    import { initializeErrorReporting, reportBackendError, flushErrorReporting, nameRequest, traceCarrier, traceQueued, markFirstToken } from './plugins/chassis/src/error-reporting.ts';
    initializeErrorReporting(Sentry, 'test');
    ${body}
  `,
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        SENTRY_DSN: enabled ? `http://public@127.0.0.1:${address.port}/42` : "",
        SENTRY_ENVIRONMENT: "verification",
        SENTRY_RELEASE: "test-release",
        SENTRY_DEPLOYMENT: "test-deployment",
        COLLECTOR_PORT: String(address.port),
        ...env,
        ...(env.CORE_API_URL === "collector" ? { CORE_API_URL: `http://127.0.0.1:${address.port}` } : {}),
      },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", () => {});
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, signal] = await once(child, "exit");
    return { events, transactions, headers, outbound, code, signal, output };
  } finally {
    clearTimeout(timeout);
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  }
}

test("real SDK sends full exception details, causes and classification", async () => {
  const { events, code, output } = await runReporting(`
    const error = Object.assign(new TypeError('top-message', { cause: new Error('root-cause') }), { stderr: 'command failed', exitCode: 17, body: { upstream: { reason: 'failure' } } });
    const { errDetail } = await import('./plugins/chassis/src/errors.ts');
    console.log(errDetail(error));
    reportBackendError(error);
    console.error('request-url', error);
    reportBackendError(new Error('record-message'), 'run:failed', { detail: 'extra-detail' });
    await flushErrorReporting();
  `);
  assert.equal(code, 0);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.contexts.TypeError.stderr, "command failed");
  assert.equal(events[0]!.contexts.TypeError.exitCode, 17);
  assert.deepEqual(events[0]!.contexts.TypeError.body, { upstream: { reason: "failure" } });
  assert.ok(output.includes("stderr=command failed"));
  assert.ok(output.includes("exitCode=17"));
  const values = events[0]!.exception.values.map((value: { value: string }) => value.value);
  assert.ok(values.includes("top-message"));
  assert.ok(values.includes("root-cause"));
  assert.ok(events[0]!.exception.values.at(-1).stacktrace.frames.length);
  assert.equal(events[0]!.tags.deployment, "test-deployment");
  assert.equal(events[0]!.release, "test-release");
  assert.equal(events[1]!.tags.error_code, "run:failed");
  assert.deepEqual(events[1]!.fingerprint, ["{{ default }}", "run:failed"]);
  assert.equal(events[1]!.extra.detail, "extra-detail");
  assert.equal(events[1]!.exception.values[0].value, "record-message");
});

test("disabled reporting leaves process listeners and logging alone", async () => {
  const { events, code, output } = await runReporting(
    `
    console.log(process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException'));
    console.error(new Error('private-message'));
    await flushErrorReporting();
  `,
    false,
  );
  assert.equal(code, 0);
  assert.equal(output.trim(), "0 0");
  assert.equal(events.length, 0);
});

test("unhandled rejection flushes a fatal unhandled event and exits", async () => {
  const { events, code } = await runReporting(`Promise.reject(new Error('private-rejection'));`);
  assert.equal(code, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.level, "fatal");
  assert.equal(events[0]!.exception.values[0].mechanism.handled, false);
});

test("fatal reporting preserves the core drain handler and avoids duplicate console events", async () => {
  const { events, code, output } = await runReporting(`
    const { shutdownOnUncaught } = await import('./src/util/process-guard.ts');
    shutdownOnUncaught('qm', () => {
      setTimeout(async () => { console.log('drained'); await flushErrorReporting(); process.exit(1); }, 100);
    });
    setTimeout(() => { throw new TypeError('private-fatal'); }, 0);
  `);
  assert.equal(code, 1);
  assert.equal(output.trim(), "drained");
  assert.equal(events.length, 1);
});

test("operator error records send one classified event with the record details", async () => {
  const { events, code, output } = await runReporting(`
    const { createErrorLog, withErrorReporting } = await import('./src/admin/error-log.ts');
    const errors = withErrorReporting(createErrorLog());
    const error = new Error('private-job-failure');
    console.error('[worker] private-job-failure');
    errors.record({category:'turn', code:'failed', message:error.message, scopeLabel:'private-scope'}, error);
    console.log((await errors.list())[0].message);
    await flushErrorReporting();
  `);
  assert.equal(code, 0);
  assert.equal(output.trim(), "private-job-failure");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.tags.error_code, "turn:failed");
  assert.equal(events[0]!.exception.values[0].value, "private-job-failure");
  assert.equal(events[0]!.extra.scopeLabel, "private-scope");
});

test("trace statuses map HTTP outcomes", () => {
  assert.deepEqual([200, 302, 401, 403, 404, 429, 422, 500].map(traceStatus), [
    "ok",
    "ok",
    "unauthenticated",
    "permission_denied",
    "not_found",
    "resource_exhausted",
    "invalid_argument",
    "internal_error",
  ]);
});

const TRACED_REQUESTS = `
  const { createServer } = await import('node:http');
  const collectorUrl = 'http://127.0.0.1:' + process.env.COLLECTOR_PORT;
  let carrier;
  let declinedCarrier;
  let reported = false;
  const server = createServer(async (req, res) => {
    nameRequest(req.method, '/v1/things/:id');
    if (req.url.startsWith('/v1/declined')) declinedCarrier = traceCarrier();
    if (req.url.startsWith('/v1/forged')) {
      reportBackendError(new Error('forged-error'));
      console.log('forged-carrier ' + JSON.stringify(traceCarrier() ?? null));
    }
    if (!reported) {
      reported = true;
      carrier = traceCarrier();
      reportBackendError(new Error('handler-error'));
    }
    await fetch('http://127.0.0.1:' + process.env.COLLECTOR_PORT + '/private-outbound/private-path?token=private-query', {
      headers: { 'x-private': 'private-header' },
    }).catch(() => {});
    res.end('ok');
    setTimeout(() => fetch(collectorUrl + '/private-detached/private-path?token=private-late').catch(() => {}), 100);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  await fetch(collectorUrl + '/private-unparented/private-path?token=private-root').catch(() => {});
  const forged = { 'sentry-trace': '0123456789abcdef0123456789abcdef-0123456789abcdef-1', baggage: 'sentry-sample_rand=0.00000001,sentry-transaction=private-dsc,sentry-user_id=private-user,sentry-private=private-key,sentry-release=private-release,sentry-environment=private-env,sentry-public_key=private-pk,sentry-trace_id=private-trace,third=private-third' };
  await fetch(base + '/v1/things/private-id?token=private-token', { headers: { 'x-qm-signature': 'private-signature', cookie: 'private-cookie' } });
  await fetch(base + '/v1/forged/private-id', { headers: forged });
  await fetch(base + '/v1/declined/1', { headers: { 'sentry-trace': 'fedcba9876543210fedcba9876543210-fedcba9876543210-0' } });
  console.log('declined-carrier ' + JSON.stringify(declinedCarrier ?? null));
  await traceQueued(declinedCarrier, 'declined-run', {}, async () => {});
  await fetch(base + '/healthz');
  await fetch(base + '/v1/runs/private-id/events');
  await traceQueued(carrier, 'run', { 'messaging.message.id': 'run-1', 'qm.surface': 'web', private: 'private-attribute' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    markFirstToken();
  });
  await traceQueued(undefined, 'stopped-run', {}, async () => ({ stopped: true }), (result) => result.stopped);
  await new Promise((resolve) => setTimeout(resolve, 300));
  reportBackendError(new Error('private-error'));
  server.close();
  await flushErrorReporting();
`;

test("tracing is off unless a valid sample rate is configured; errors still report", async () => {
  for (const env of [{}, { SENTRY_TRACES_SAMPLE_RATE: "5" }, { SENTRY_TRACES_SAMPLE_RATE: "0" }] as Record<
    string,
    string
  >[]) {
    const run = await runReporting(TRACED_REQUESTS, true, env);
    assert.equal(run.code, 0);
    assert.equal(run.transactions.length, 0);
    assert.equal(run.events.length, 3);
  }
});

test("sampled requests and queued runs become scrubbed, connected transactions", async () => {
  const on = await runReporting(TRACED_REQUESTS, true, { SENTRY_TRACES_SAMPLE_RATE: "1" });
  assert.equal(on.code, 0);
  assert.equal(on.events.length, 3);
  assert.match(
    /declined-carrier (.*)/.exec(on.output)?.[1] ?? "",
    /^\{"sentryTrace":"fedcba9876543210fedcba9876543210-[0-9a-f]{16}-0"\}$/,
    "a run queued by an unsampled request carries the negative decision",
  );
  assert.ok(
    on.transactions.every(
      (event) =>
        event.transaction !== "declined-run" && event.contexts.trace.trace_id !== "fedcba9876543210fedcba9876543210",
    ),
    "a run queued by an unsampled request is not resampled",
  );
  const forgedCarrier = /forged-carrier (.*)/.exec(on.output)?.[1];
  assert.ok(forgedCarrier && forgedCarrier !== "null", "a continued request still hands its trace to runs");
  assert.doesNotMatch(forgedCarrier, /private/);
  assert.deepEqual(Object.keys(JSON.parse(forgedCarrier)), ["sentryTrace"]);
  assert.match(forgedCarrier, /"sentryTrace":"0123456789abcdef0123456789abcdef-/);
  assert.doesNotMatch(JSON.stringify(on.transactions), /private/);
  assert.doesNotMatch(JSON.stringify(on.headers), /private/);
  const items = new Map([...on.events, ...on.transactions].map((item) => [item.event_id, item]));
  const traced = on.headers.filter((h) => h.trace);
  assert.ok(traced.length >= on.events.length + on.transactions.length, "every envelope carries a trace header");
  for (const header of traced) {
    const item = items.get(header.event_id);
    assert.equal(header.trace.trace_id, item?.contexts.trace.trace_id, "the envelope trace header matches its event");
    assert.equal(header.trace.release, "test-release");
  }
  const handlerError = on.events.find((event) => event.exception.values[0].value === "handler-error");
  assert.equal(handlerError?.transaction, "GET /v1/things/:id", "errors inside a request carry the route template");
  assert.deepEqual(
    on.transactions.filter((event) => ["db", "http.client"].includes(event.contexts.trace.op)),
    [],
    "detached and unparented work is not sent as its own transaction",
  );
  const names = on.transactions.map((event) => event.transaction);
  assert.deepEqual(names.sort(), ["GET /v1/things/:id", "GET /v1/things/:id", "run", "stopped-run"].sort());
  assert.equal(
    on.transactions.find((event) => event.transaction === "stopped-run")?.contexts.trace.status,
    "cancelled",
  );
  const [request] = on.transactions.filter(
    (event) => event.transaction === "GET /v1/things/:id" && event.contexts.trace.op === "http.server",
  );
  assert.ok(request, "the routed request is named by its template");
  assert.equal(request.contexts.trace.data["http.route"], "/v1/things/:id");
  assert.equal(request.request, undefined);
  const outbound = request.spans.find((span: { op: string }) => span.op === "http.client");
  assert.match(outbound.description, /^GET http:\/\/127\.0\.0\.1:\d+$/);
  const run = on.transactions.find((event) => event.transaction === "run")!;
  assert.equal(run.contexts.trace.op, "queue.process");
  assert.equal(run.contexts.trace.trace_id, request.contexts.trace.trace_id, "the run continues the request's trace");
  assert.equal(run.contexts.trace.data["messaging.message.id"], "run-1");
  assert.equal(run.contexts.trace.data["qm.surface"], "web");
  assert.equal(run.measurements.time_to_first_token.unit, "millisecond");
  assert.ok(run.measurements.time_to_first_token.value >= 15);
  assert.deepEqual(run.tags, { service: "test", deployment: "test-deployment" });
  assert.equal(run.release, "test-release");
  assert.equal(run.environment, "verification");
});

test("trace context goes only to QM's own services", async () => {
  const external = await runReporting(TRACED_REQUESTS, true, { SENTRY_TRACES_SAMPLE_RATE: "1" });
  assert.ok(external.outbound.length > 0);
  assert.ok(external.outbound.every((h) => h["sentry-trace"] === undefined && h.baggage === undefined));
  const internal = await runReporting(TRACED_REQUESTS, true, {
    SENTRY_TRACES_SAMPLE_RATE: "1",
    CORE_API_URL: "collector",
  });
  assert.ok(internal.outbound.some((h) => typeof h["sentry-trace"] === "string"));
});

test("reportFailure sends one classified event per distinct failure and skips cancellations and recorded errors", async () => {
  const { events, code, output } = await runReporting(`
    console.error = (line) => console.log(line);
    const { reportFailure } = await import('./src/util/errors.ts');
    const { createErrorLog, withErrorReporting } = await import('./src/admin/error-log.ts');
    const errors = withErrorReporting(createErrorLog());
    const recorded = new Error('private-turn-failure');
    errors.record({category:'turn', code:'error', message:recorded.message, scopeLabel:'private-scope'}, recorded);
    reportFailure('scheduler: fire', recorded);
    reportFailure('scheduler: fire', new DOMException('private-cancel', 'AbortError'));
    const infra = new Error('private-db-down');
    reportFailure('scheduler: tick', infra);
    reportFailure('worker: background run crashed', infra);
    reportFailure('audit: persist event', 'private-string-throw');
    const reportedFirst = new Error('private-tool-failure');
    reportFailure('tools: persist artifact', reportedFirst);
    errors.record({category:'turn', code:'error', message:reportedFirst.message, scopeLabel:'private-scope'}, reportedFirst);
    await flushErrorReporting();
  `);
  assert.equal(code, 0);
  assert.deepEqual(
    events.map((event) => event.tags.error_code),
    ["turn:error", "scheduler:tick", "audit:persist_event", "tools:persist_artifact"],
  );
  assert.equal(events[1]!.exception.values[0].value, "private-db-down");
  const tick = output.split("\n").find((line) => line.startsWith("[failed] scheduler: tick"));
  assert.match(tick ?? "", new RegExp(`\\[sentry=${events[1]!.event_id}\\]: private-db-down \\{stack: `));
});

test("sandbox cleanup errors send both original failures and their stacks", async () => {
  const { events, code } = await runReporting(`
    const { SandboxProvisionCleanupError } = await import('./src/sandbox/sandbox.ts');
    const provision = new Error('provision failed', { cause: new Error('provision root') });
    const cleanup = new Error('cleanup failed');
    reportBackendError(new SandboxProvisionCleanupError({ id: 'test', rootDir: '/tmp' }, cleanup, provision));
    await flushErrorReporting();
  `);
  assert.equal(code, 0);
  const values = events[0]!.exception.values;
  for (const message of ["provision failed", "provision root", "cleanup failed"]) {
    const value = values.find((entry: { value: string }) => entry.value === message);
    assert.ok(value?.stacktrace.frames.length, message);
  }
});
