import { errMessage } from "./errors.ts";

export function shutdownOnUncaught(label: string, shutdown: (reason: string) => void): void {
  const describe = (e: unknown): string => (e instanceof Error && e.stack ? e.stack : errMessage(e));
  process.on("uncaughtException", (error) => {
    console.error(`[${label}] uncaught exception; draining and exiting:`, describe(error));
    process.exitCode = 1;
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[${label}] unhandled rejection; draining and exiting:`, describe(reason));
    process.exitCode = 1;
    shutdown("unhandledRejection");
  });
}
