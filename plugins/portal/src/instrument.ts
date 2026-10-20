import { initializeErrorReporting } from "../../chassis/src/error-reporting.ts";

await initializeErrorReporting(() => import("@sentry/node"), "portal");
