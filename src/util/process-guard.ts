import { describeActiveRequest } from "../../plugins/chassis/src/error-reporting.ts";
import { errMessage } from "./errors.ts";

let fatal = false;

export const fatalShutdown = (): boolean => fatal;

export function shutdownOnUncaught(label: string, shutdown: (reason: string) => void): void {
  const onFatal = (kind: string) => (e: unknown) => {
    const request = describeActiveRequest();
    console.error(
      `[${label}] ${kind}${request ? ` ${request}` : ""}; draining and exiting:`,
      e instanceof Error && e.stack ? e.stack : errMessage(e),
    );
    process.exitCode = 1;
    fatal = true;
    shutdown(kind);
  };
  process.on("uncaughtException", onFatal("uncaught exception"));
  process.on("unhandledRejection", onFatal("unhandled rejection"));
}
