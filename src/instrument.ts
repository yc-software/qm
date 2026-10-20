import { initializeErrorReporting } from "../plugins/chassis/src/error-reporting.ts";

await initializeErrorReporting(() => import("@sentry/node"), "core");
