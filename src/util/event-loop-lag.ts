import { monitorEventLoopDelay } from "node:perf_hooks";
import { createSweeper, type Sweeper } from "./sweeper.ts";

const RESOLUTION_MS = 20;

export function logEventLoopLag(intervalMs = 60_000): Sweeper {
  const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  delay.enable();
  const lagMs = (nanoseconds: number) => Math.max(0, Math.round(nanoseconds / 1e6 - RESOLUTION_MS));
  const sweeper = createSweeper(
    () => {
      console.log(
        `[event-loop] lag p50 ${lagMs(delay.percentile(50))} p99 ${lagMs(delay.percentile(99))} max ${lagMs(delay.max)} ms`,
      );
      delay.reset();
    },
    intervalMs,
    { label: "event-loop lag" },
  );
  sweeper.start();
  return sweeper;
}
