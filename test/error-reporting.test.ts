import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { sanitizeErrorEvent } from "../plugins/chassis/src/error-reporting.ts";

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

async function runReporting(body: string, enabled = true) {
  const events: Record<string, any>[] = [];
  const collector = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const lines = Buffer.concat(chunks).toString().split("\n");
    for (let i = 1; i + 1 < lines.length; i += 2) {
      if (JSON.parse(lines[i]!).type === "event") events.push(JSON.parse(lines[i + 1]!));
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
    import { initializeErrorReporting, reportBackendError, flushErrorReporting } from './plugins/chassis/src/error-reporting.ts';
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
    return { events, code, signal, output };
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
