import type { Server, ServerResponse } from "node:http";
import { flushErrorReporting } from "./error-reporting.ts";

const QUIET_MS = 3_000;
const DEADLINE_MS = 20_000;
const TICK_MS = 250;

export function drainOnSigterm(server: Server, label: string): void {
  const open = new Set<ServerResponse>();
  let lastRequestAt = 0;
  let draining = false;
  server.prependListener("request", (_req, res: ServerResponse) => {
    lastRequestAt = Date.now();
    open.add(res);
    if (draining) res.shouldKeepAlive = false;
    res.once("close", () => open.delete(res));
  });
  const exit = (): void => void flushErrorReporting().finally(() => process.exit());
  process.once("SIGTERM", () => {
    draining = true;
    console.log(`[${label}] SIGTERM received, draining`);
    for (const res of open) if (!res.headersSent) res.shouldKeepAlive = false;
    server.closeIdleConnections();
    setTimeout(() => {
      console.warn(`[${label}] drain overran ${DEADLINE_MS} ms; closing ${open.size} open responses`);
      server.closeAllConnections();
      exit();
    }, DEADLINE_MS).unref();
    const tick = setInterval(() => {
      for (const res of open)
        if (String(res.getHeader("content-type") ?? "").startsWith("text/event-stream")) res.end();
      if (Date.now() - lastRequestAt < QUIET_MS) return;
      clearInterval(tick);
      server.close(exit);
      server.closeIdleConnections();
    }, TICK_MS);
  });
}
