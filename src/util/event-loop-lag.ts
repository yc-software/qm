import { constants, monitorEventLoopDelay, PerformanceObserver, type NodeGCPerformanceDetail } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { createSweeper, type Sweeper } from "./sweeper.ts";

const RESOLUTION_MS = 20;
const BYTES_PER_MB = 1_048_576;
const GC_WARN_MS = 100;

const GC_KINDS: Record<number, string> = {
  [constants.NODE_PERFORMANCE_GC_MINOR]: "scavenge",
  [constants.NODE_PERFORMANCE_GC_MAJOR]: "mark-sweep-compact",
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental-marking",
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};

export function logEventLoopLag(intervalMs = 60_000, gcWarnMs = GC_WARN_MS): Sweeper {
  const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  delay.enable();
  const lagMs = (nanoseconds: number) => Math.max(0, Math.round(nanoseconds / 1e6 - RESOLUTION_MS));
  const mb = (bytes: number) => Math.round(bytes / BYTES_PER_MB);
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration > gcWarnMs) {
        const detail = (entry as { detail?: NodeGCPerformanceDetail }).detail;
        const kind = (detail?.kind !== undefined && GC_KINDS[detail.kind]) || "unknown";
        console.warn(`[gc] kind=${kind} duration=${Math.round(entry.duration)} ms`);
      }
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });
  const sweeper = createSweeper(
    () => {
      console.log(
        `[event-loop] lag p50 ${lagMs(delay.percentile(50))} p99 ${lagMs(delay.percentile(99))} max ${lagMs(delay.max)} ms`,
      );
      delay.reset();
      const mem = process.memoryUsage();
      const heap = getHeapStatistics();
      console.log(
        `[memory] rss=${mb(mem.rss)} heapUsed=${mb(mem.heapUsed)} heapTotal=${mb(mem.heapTotal)} heapLimit=${mb(heap.heap_size_limit)} external=${mb(mem.external)} arrayBuffers=${mb(mem.arrayBuffers)} MB`,
      );
    },
    intervalMs,
    { label: "event-loop lag" },
  );
  sweeper.start();
  return {
    start(overrideMs?: number) {
      delay.enable();
      gcObserver.observe({ entryTypes: ["gc"] });
      sweeper.start(overrideMs);
    },
    stop() {
      gcObserver.disconnect();
      delay.disable();
      return sweeper.stop();
    },
  };
}
