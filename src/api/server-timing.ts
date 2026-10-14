export function serverTimingHeader(timings: Iterable<readonly [string, number]>, prefix = ""): string {
  return [...timings].map(([name, ms]) => `${prefix}${name};dur=${ms.toFixed(1)}`).join(", ");
}
