import * as Sentry from "@sentry/node";
import { initializeErrorReporting } from "../../chassis/src/error-reporting.ts";

initializeErrorReporting(Sentry, "auth", () => import("@sentry/node-native"));
