import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { sanitizeErrorEvent } from "../plugins/chassis/src/error-reporting.ts";
import { sanitizeTransactionEvent, traceStatus } from "../plugins/chassis/src/timing.ts";

test("error event allowlist excludes content, credentials, paths and ambient scope", () => {
  const clean = sanitizeErrorEvent({
    type: undefined,
    message: "private-prompt",
    logentry: { message: "private-prompt" },
    user: { email: "private-email" },
    request: { data: "private-body", headers: { authorization: "private-token" } },
    breadcrumbs: [{ message: "private-breadcrumb" }],
    extra: { payload: "private-payload" },
    contexts: { private: { value: "private-context" } },
    server_name: "private-host",
    transaction: "private-url",
    tags: { service: "core", deployment: "test", private: "private-tag", error_code: "run:failed" },
    exception: {
      values: [
        {
          type: "TypeError",
          value: "private-message",
          stacktrace: {
            frames: [
              {
                filename: "/private-user/src/server.ts?private-query",
                function: "serve",
                lineno: 42,
                vars: { token: "private-local" },
                context_line: "private-source",
                pre_context: ["private-before"],
              },
            ],
          },
        },
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(clean), /private/);
  assert.equal(clean.exception?.values?.[0]?.type, "TypeError");
  assert.deepEqual(clean.exception?.values?.[0]?.stacktrace?.frames?.[0], {
    filename: "server.ts",
    function: "serve",
    lineno: 42,
    colno: undefined,
    in_app: undefined,
  });
  assert.deepEqual(clean.fingerprint, ["{{ default }}", "run:failed"]);
});

async function runReporting(body: string, enabled = true, env: Record<string, string> = {}) {
  const events: Record<string, any>[] = [];
  const transactions: Record<string, any>[] = [];
  const collector = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const lines = Buffer.concat(chunks).toString().split("\n");
    if (req.url?.includes("outbound")) {
      res.end("{}");
      return;
    }
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
    import { initializeErrorReporting, reportBackendError, startTiming, flushErrorReporting } from './plugins/chassis/src/error-reporting.ts';
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
    return { events, transactions, code, signal, output };
  } finally {
    clearTimeout(timeout);
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  }
}

test("real SDK sends one redacted exception when captured and logged, plus a classified record", async () => {
  const { events, code } = await runReporting(`
    const error = new TypeError('private-message');
    reportBackendError(error);
    console.error('private-request-url', error);
    reportBackendError(new Error('private-record'), 'run:failed');
    await flushErrorReporting();
  `);
  assert.equal(code, 0);
  assert.equal(events.length, 2);
  assert.doesNotMatch(JSON.stringify(events), /private-/);
  assert.ok(events[0]!.exception.values[0].stacktrace.frames.length);
  assert.equal(events[0]!.tags.deployment, "test-deployment");
  assert.equal(events[0]!.release, "test-release");
  assert.equal(events[1]!.tags.error_code, "run:failed");
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

test("operator error records retain local details and send one classified event after safe logging", async () => {
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
  assert.doesNotMatch(JSON.stringify(events), /private-/);
});

test("transaction allowlist keeps timing shape only and rejects unsafe names", () => {
  const clean = sanitizeTransactionEvent(
    {
      type: "transaction",
      event_id: "b".repeat(32),
      transaction: "GET /v1/sessions/:id",
      transaction_info: { source: "url" },
      start_timestamp: 10,
      timestamp: 10.5,
      environment: "verification",
      release: "test-release",
      user: { id: "private-user" },
      request: { url: "https://private-host/v1/sessions/private-id", headers: { authorization: "private-token" } },
      breadcrumbs: [{ message: "private-breadcrumb" }],
      extra: { sql: "private-sql" },
      server_name: "private-host",
      spans: [
        { span_id: "1", trace_id: "2", description: "SELECT private", start_timestamp: 10, timestamp: 10.1, data: {} },
      ],
      tags: { service: "core", http_status: "private", private: "private-tag", surface: "private-tag" },
      measurements: { queue_wait: { value: 5, unit: "millisecond" }, private: { value: 1, unit: "millisecond" } },
      contexts: {
        trace: {
          trace_id: "a".repeat(32),
          span_id: "c".repeat(16),
          op: "http.server",
          status: "ok",
          data: { private: 1, http_status: "200", surface: "web", page: "private id", "sentry.sample_rate": 1 },
        },
        otel: { resource: { "service.name": "private-host" } },
        runtime: { name: "node" },
        private: { value: "private-context" },
      },
    },
    "node",
  );
  assert.doesNotMatch(JSON.stringify(clean), /private/);
  assert.equal(clean?.transaction, "GET /v1/sessions/:id");
  assert.deepEqual(clean?.transaction_info, { source: "route" });
  assert.deepEqual(clean?.tags, { service: "core", http_status: "200", surface: "web", page: "other" });
  assert.deepEqual(clean?.measurements, { queue_wait: { value: 5, unit: "millisecond" } });
  assert.deepEqual(clean?.spans, []);
  assert.deepEqual(clean?.contexts?.trace, {
    trace_id: "a".repeat(32),
    span_id: "c".repeat(16),
    op: "http.server",
    status: "ok",
    origin: "manual",
  });
  const base = {
    type: "transaction" as const,
    start_timestamp: 1,
    timestamp: 2,
    contexts: { trace: { trace_id: "a".repeat(32), span_id: "c".repeat(16), op: "queue.task", status: "ok" } },
  };
  for (const transaction of ["GET /v1/sessions/1234?token=private", "private text", "GET https://x/", undefined])
    assert.equal(sanitizeTransactionEvent({ ...base, transaction }, "node"), null);
  assert.equal(sanitizeTransactionEvent({ ...base, transaction: "run", timestamp: 0 }, "node"), null);
  assert.equal(sanitizeTransactionEvent({ ...base, transaction: "run", contexts: {} }, "node"), null);
  const traced = (op: string, status: string) => ({
    ...base,
    transaction: "run",
    contexts: { trace: { ...base.contexts.trace, op, status } },
  });
  assert.equal(sanitizeTransactionEvent(traced("private.op", "ok"), "node"), null);
  assert.equal(sanitizeTransactionEvent(traced("queue.task", "private status"), "node"), null);
  assert.equal(sanitizeTransactionEvent(traced("queue.task", "ok"), "node")?.contexts?.trace?.op, "queue.task");
  const bucketed = sanitizeTransactionEvent(
    {
      ...traced("queue.task", "ok"),
      contexts: {
        trace: {
          ...base.contexts.trace,
          op: "queue.task",
          status: "ok",
          data: { surface: "private-surface", origin: "private-origin", http_status: "private", page: "private" },
        },
      },
    },
    "node",
  );
  assert.deepEqual(bucketed?.tags, { surface: "other", origin: "other", http_status: "other", page: "other" });
  const inherited = sanitizeTransactionEvent(
    {
      ...traced("queue.task", "ok"),
      contexts: {
        trace: {
          ...base.contexts.trace,
          op: "queue.task",
          status: "ok",
          data: { toString: "private prompt", constructor: "private-user", hasOwnProperty: "private" },
        },
      },
    },
    "node",
  );
  assert.deepEqual(inherited?.tags, {});
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

test("real SDK sends sanitized sampled transactions only when a sample rate is configured", async () => {
  const body = `
    startTiming('queue.task', 'run', Date.now() - 500)?.({ status: 'ok', endMs: Date.now(),
      data: { surface: 'web', origin: 'human', private: 'private-tag', page: 'private-page' },
      measurements: { queue_wait: 20, private: 5 } });
    const finish = startTiming('http.server', 'GET /*');
    finish?.({ name: 'GET /v1/sessions/:id', status: 'not_found', data: { http_status: '404' } });
    reportBackendError(new Error('private-error'));
    await fetch('http://127.0.0.1:' + process.env.COLLECTOR_PORT + '/private-outbound').catch(() => {});
    await flushErrorReporting();
  `;
  const off = await runReporting(body);
  assert.equal(off.code, 0);
  assert.equal(off.transactions.length, 0);
  assert.equal(off.events.length, 1);
  const invalid = await runReporting(body, true, { SENTRY_TRACES_SAMPLE_RATE: "5" });
  assert.equal(invalid.transactions.length, 0);
  const on = await runReporting(body, true, { SENTRY_TRACES_SAMPLE_RATE: "1" });
  assert.equal(on.code, 0);
  assert.equal(on.events.length, 1);
  assert.equal(on.transactions.length, 2);
  assert.doesNotMatch(JSON.stringify(on.transactions), /private/);
  const [run, request] = on.transactions;
  assert.equal(run!.transaction, "run");
  assert.ok(Math.abs(run!.timestamp - run!.start_timestamp - 0.5) < 0.05);
  assert.deepEqual(run!.tags, {
    service: "test",
    deployment: "test-deployment",
    surface: "web",
    origin: "human",
    page: "other",
  });
  assert.deepEqual(run!.measurements, { queue_wait: { value: 20, unit: "millisecond" } });
  assert.equal(run!.contexts.trace.op, "queue.task");
  assert.equal(run!.release, "test-release");
  assert.equal(run!.environment, "verification");
  assert.equal(request!.transaction, "GET /v1/sessions/:id");
  assert.equal(request!.contexts.trace.status, "not_found");
  assert.equal(request!.tags.http_status, "404");
  assert.deepEqual(Object.keys(run!).sort(), [
    "contexts",
    "environment",
    "event_id",
    "measurements",
    "platform",
    "release",
    "sdk",
    "spans",
    "start_timestamp",
    "tags",
    "timestamp",
    "transaction",
    "transaction_info",
    "type",
  ]);
});

test("reportFailure sends one classified event per distinct failure and skips cancellations and recorded errors", async () => {
  const { events, code } = await runReporting(`
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
  assert.doesNotMatch(JSON.stringify(events), /private-/);
  assert.equal(events[1]!.exception.values[0].value, "scheduler:tick");
});
