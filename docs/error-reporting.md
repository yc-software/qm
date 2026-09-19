# Backend error reporting

Set `SENTRY_DSN` in each backend service's deployment environment to enable Sentry. Leave it unset to disable reporting. Core (including in-process Slack), workers, web/admin servers, and portal/auth servers report to the configured project. This does not add browser instrumentation.

Use a separate project for deployments with different operators or data boundaries. Configure `SENTRY_ENVIRONMENT` (for example, `production` or `staging`) and `SENTRY_DEPLOYMENT` (a non-sensitive deployment identifier). `SENTRY_RELEASE` overrides the image's `GIT_SHA`. Backend images built by the AWS CLI receive the source revision automatically. A combined web/admin process uses service `web`; a combined portal/auth process uses service `portal`.

Reporting captures uncaught exceptions, unhandled promise rejections, HTTP handler and authentication delivery failures, and the core's operator error records. Recorded failures carry `error_code` and a matching grouping fingerprint. Recorded exceptions preserve their original stack; records without an exception carry the recording call's stack. Repeated capture of the same error object is deduplicated by the SDK. Ordinary console logs and expected failures outside these boundaries are not reported.

Only error events are enabled by default. Profiling, logs, replay, request instrumentation, and breadcrumbs are disabled. Sampled performance tracing is described below. Before transmission, an allowlist retains timestamps, release/environment, service/deployment, internal failure codes, built-in exception type, stack filenames, function names and line/column numbers, and handled status. Raw error messages, request bodies and headers, URLs, users, local variables, source context, ambient tags, and extras are discarded. Full error details remain in existing application logs. Deployment labels and release values must not contain secrets or personal data.

The SDK preserves existing fatal-error drain handlers. When no rejection handler exists it flushes and exits unsuccessfully. Core's explicit shutdown paths and web startup failures allow up to two seconds for pending error delivery. Delivery is best effort and never a substitute for application logs or infrastructure health alarms.

After deployment, verify a synthetic backend failure reaches the intended project with the expected release, environment, deployment and service. Check that its stack is readable and its payload contains no application content. Test alerts against that event before relying on notifications. Disable reporting by removing `SENTRY_DSN` and redeploying; retain the prior immutable application candidate for code rollback.

## Optional performance tracing

Set `SENTRY_TRACES_SAMPLE_RATE` (a fraction between 0 and 1; unset, 0, or an invalid value keeps tracing off) on a backend service that already has `SENTRY_DSN` to sample transactions. Start with `0.1`. Tracing enables the SDK's OpenTelemetry tracer for manual spans only; no automatic HTTP, database, model, or tool instrumentation is registered, so transactions contain no child spans and no trace headers are propagated to other services.

The core reports one transaction per sampled HTTP request except `/healthz` (`http.server`, named by the registered route template such as `GET /v1/sessions/:id`; unregistered or pattern-matched paths are reported as `METHOD /*` and deployment subdomain proxying as `/deployment-proxy/*`) and one per terminal run (`queue.task` `run`, with a `queue_wait` measurement and `surface` and `origin` tags drawn from fixed lists). Every transaction is rebuilt from an allowlist before transmission: timestamps, release, environment, service, deployment, the fixed name, span status, an HTTP status code, and millisecond measurements. Raw URLs, query strings, headers, bodies, user identifiers, host names, and span attributes are discarded.

Browser timing uses `SENTRY_BROWSER_TRACES_SAMPLE_RATE` on the web server together with `SENTRY_BROWSER_DSN`; see the web-ui README.
