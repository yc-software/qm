let pending: { destination: string | null } | null = null;

export function navigateNext(destination: string | null = null): void {
  pending = { destination };
}

export function historyWrite(current: string, next: string): "push" | "replace" | "skip" | "none" {
  if (pending?.destination && next !== pending.destination) return "skip";
  const push = pending !== null;
  pending = null;
  if (current === next) return "none";
  return push ? "push" : "replace";
}

export function abandonNavigation(destination: string | null): boolean {
  if (pending?.destination !== destination) return false;
  pending = null;
  return true;
}
