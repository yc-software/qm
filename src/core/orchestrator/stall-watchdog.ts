export interface StallWatchdog {
  progress(): void;
  stop(): void;
}

export function startStallWatchdog(stallMs: number, onStalled: () => void): StallWatchdog {
  const timer = setTimeout(onStalled, stallMs);
  timer.unref?.();
  return {
    progress: () => void timer.refresh(),
    stop: () => clearTimeout(timer),
  };
}
