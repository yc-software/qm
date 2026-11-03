export interface StallWatchdog {
  progress(): void;
  stop(): void;
}

export function startStallWatchdog(stallMs: number, onStalled: () => void): StallWatchdog {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    onStalled();
  }, stallMs);
  timer.unref?.();
  return {
    progress: () => {
      if (!fired) timer.refresh();
    },
    stop: () => clearTimeout(timer),
  };
}
