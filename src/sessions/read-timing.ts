import { AsyncLocalStorage } from "node:async_hooks";

type ReadStage = "total" | "transcript" | "pins";

const timings = new AsyncLocalStorage<Map<string, number>>();

export async function timeSessionRead<T>(stage: ReadStage, read: () => T | Promise<T>): Promise<T> {
  const current = timings.getStore();
  if (!current) return read();
  const start = performance.now();
  try {
    return await read();
  } finally {
    current.set(stage, (current.get(stage) ?? 0) + performance.now() - start);
  }
}

export function collectSessionReadTiming<T>(collected: Map<string, number>, read: () => Promise<T>): Promise<T> {
  return timings.run(collected, () => timeSessionRead("total", read));
}
