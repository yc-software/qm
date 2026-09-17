import * as Sentry from "@sentry/node";
import { initializeErrorReporting } from "../plugins/chassis/src/error-reporting.ts";

initializeErrorReporting(Sentry, "core");
