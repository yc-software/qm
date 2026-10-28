let pending: object | null = null;

export function beginNavigation(): object {
  const token = {};
  pending = token;
  return token;
}

export function endNavigation(token: object): boolean {
  if (pending !== token) return false;
  pending = null;
  return true;
}

export function cancelNavigation(): void {
  pending = null;
}

export function navigationInFlight(): boolean {
  return pending !== null;
}
