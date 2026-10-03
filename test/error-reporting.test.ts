import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { traceStatus } from "../plugins/chassis/src/timing.ts";

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

test("fatal worker shutdown flushes diagnostics and exits without a graceful handback", async () => {
  const { events, code } = await runReporting(`
    const { shutdownOnUncaught } = await import('./src/util/process-guard.ts');
    shutdownOnUncaught('qm');
    setTimeout(() => { throw new TypeError('private-fatal'); }, 0);
  `);
  assert.equal(code, 1);
  assert.equal(events.length, 1);
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

test("real SDK preserves sampled transaction data only when a sample rate is configured", async () => {
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
  assert.match(JSON.stringify(on.transactions), /private-tag/);
  const [run, request] = on.transactions;
  assert.equal(run!.transaction, "run");
  assert.ok(Math.abs(run!.timestamp - run!.start_timestamp - 0.5) < 0.05);
  assert.deepEqual(run!.tags, {
    service: "test",
    deployment: "test-deployment",
  });
  assert.deepEqual(run!.measurements, {
    queue_wait: { value: 20, unit: "millisecond" },
    private: { value: 5, unit: "millisecond" },
  });
  assert.equal(run!.contexts.trace.data.private, "private-tag");
  assert.equal(run!.contexts.trace.data.page, "private-page");
  assert.equal(run!.contexts.trace.op, "queue.task");
  assert.equal(run!.release, "test-release");
  assert.equal(run!.environment, "verification");
  assert.equal(request!.transaction, "GET /v1/sessions/:id");
  assert.equal(request!.contexts.trace.status, "not_found");
  assert.equal(request!.contexts.trace.data.http_status, "404");
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
