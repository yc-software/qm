import * as Sentry from "@sentry/node";
import { initializeErrorReporting } from "../../../common/error-reporting.ts";

initializeErrorReporting(Sentry, "auth");
