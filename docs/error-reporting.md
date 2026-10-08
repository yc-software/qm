# Backend error reporting

Set `SENTRY_DSN` in each backend service's deployment environment to enable Sentry. Leave it unset to disable reporting. Core (including in-process Slack), workers, web/admin servers, and portal/auth servers report to the configured project. This does not add browser instrumentation.

Use a separate project for deployments with different operators or data boundaries. Configure `SENTRY_ENVIRONMENT` (for example, `production` or `staging`) and `SENTRY_DEPLOYMENT` (a non-sensitive deployment identifier). `SENTRY_RELEASE` overrides the image's `GIT_SHA`. Backend images built by the AWS CLI receive the source revision automatically. A combined web/admin process uses service `web`; a combined portal/auth process uses service `portal`.

Reporting captures uncaught exceptions, unhandled promise rejections, HTTP handler and authentication delivery failures, and the core's operator error records. Recorded failures carry `error_code` and a matching grouping fingerprint. Recorded exceptions preserve their original stack; records without an exception carry the recording call's stack. Repeated capture of the same error object is deduplicated by the SDK. Ordinary console logs and expected failures outside these boundaries are not reported.

Only error events are enabled by default. Profiling, logs, replay and request instrumentation are disabled. Sampled performance tracing is described below. Events are sent unredacted: error messages, cause chains (as linked exceptions), stacks, and the failure's context (the `detail` passed to `reportFailure`, or the operator error record's category, code, message, scope and session) all reach Sentry so issues can be debugged there directly. Each recorded failure's log line also carries its Sentry event id (`[sentry=<id>]`).

The SDK preserves existing fatal-error drain handlers. When no rejection handler exists it flushes and exits unsuccessfully. Core's explicit shutdown paths and web startup failures allow up to two seconds for pending error delivery. Delivery is best effort and never a substitute for application logs or infrastructure health alarms.

After deployment, verify a synthetic backend failure reaches the intended project with the expected release, environment, deployment and service. Check that its message and stack are readable. Test alerts against that event before relying on notifications. Disable reporting by removing `SENTRY_DSN` and redeploying; retain the prior immutable application candidate for code rollback.

## Optional performance tracing

Set `SENTRY_TRACES_SAMPLE_RATE` (a fraction between 0 and 1; unset, 0, or an invalid value keeps tracing off) on a backend service that already has `SENTRY_DSN` to sample transactions. Start with `0.1`. Tracing enables the SDK's OpenTelemetry tracer for manual spans only; no automatic HTTP, database, model, or tool instrumentation is registered, and no trace headers are propagated to other services.

The core reports one transaction per sampled HTTP request except `/healthz` (`http.server`, named by the registered route template such as `GET /v1/sessions/:id`; unregistered or pattern-matched paths are reported as `METHOD /*` and deployment subdomain proxying as `/deployment-proxy/*`) and one per terminal run (`queue.task` `run`, with a `queue_wait` measurement and `surface` and `origin` attributes). Transactions are sent without scrubbing: URLs including query strings, span descriptions and attributes, child spans, measurements, and any attached request or user context reach Sentry unchanged. Route names remain grouped by the registered template; the original request URL is retained as a span attribute.

Browser timing uses `SENTRY_BROWSER_TRACES_SAMPLE_RATE` on the web server together with `SENTRY_BROWSER_DSN`; see the web-ui README.

Browser Sentry ignores plain network `TypeError` failures (`Failed to fetch`, `NetworkError when attempting to fetch resource.`, `Load failed`) and `AbortError` cancellations; HTTP 4xx/5xx failures still report.
