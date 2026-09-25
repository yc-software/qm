export function pathUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}
