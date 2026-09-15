import { errMessage } from "./errors.ts";

export function shutdownOnUncaught(label: string, shutdown: (reason: string) => void): void {
  const onFatal = (kind: string) => (e: unknown) => {
    console.error(`[${label}] ${kind}; draining and exiting:`, e instanceof Error && e.stack ? e.stack : errMessage(e));
    process.exitCode = 1;
    shutdown(kind);
  };
  process.on("uncaughtException", onFatal("uncaught exception"));
  process.on("unhandledRejection", onFatal("unhandled rejection"));
}
