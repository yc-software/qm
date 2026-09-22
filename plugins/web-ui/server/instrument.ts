import * as Sentry from "@sentry/node";
import { initializeErrorReporting } from "../../chassis/src/error-reporting.ts";

initializeErrorReporting(Sentry, "web");
