import { flushErrorReporting } from "../../plugins/chassis/src/error-reporting.ts";
import { errMessage } from "./errors.ts";

export function shutdownOnUncaught(
  label: string,
  shutdown: (reason: string) => void = () => {
    void flushErrorReporting().finally(() => process.exit(1));
  },
): void {
  const onFatal = (kind: string) => (e: unknown) => {
    console.error(`[${label}] ${kind}; exiting:`, e instanceof Error && e.stack ? e.stack : errMessage(e));
    process.exitCode = 1;
    shutdown(kind);
  };
  process.on("uncaughtException", onFatal("uncaught exception"));
  process.on("unhandledRejection", onFatal("unhandled rejection"));
}
