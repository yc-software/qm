export function liveTurnThreadRef(o: {
  mountedThreadRef: string | null;
  isStreaming: boolean;
  pendingSend: string | null;
}): string | null {
  if (o.mountedThreadRef === null) return null;
  return o.isStreaming || o.pendingSend === o.mountedThreadRef ? o.mountedThreadRef : null;
}
