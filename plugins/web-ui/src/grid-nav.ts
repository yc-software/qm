const STEPS: Record<string, (columns: number) => number> = {
  ArrowRight: () => 1,
  ArrowLeft: () => -1,
  ArrowDown: (columns) => columns,
  ArrowUp: (columns) => -columns,
};

export function nextGridIndex(current: number, key: string, count: number, columns: number): number | null {
  const step = STEPS[key]?.(columns);
  if (step === undefined || count <= 0) return null;
  const next = current + step;
  if (next < 0 || next >= count) return null;
  return next;
}
