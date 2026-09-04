const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export function proxyHeaders<T extends string | string[]>(
  headers: Record<string, T | undefined>,
  extra: Iterable<string> = [],
): Record<string, T> {
  const dropped = new Set([...HOP_BY_HOP, ...[...extra].map((name) => name.toLowerCase())]);
  const connection = Object.entries(headers).find(([name]) => name.toLowerCase() === "connection")?.[1];
  let connectionList = "";
  if (typeof connection === "string") connectionList = connection;
  else if (Array.isArray(connection)) connectionList = connection.join(",");
  for (const name of connectionList.split(",")) {
    if (name.trim()) dropped.add(name.trim().toLowerCase());
  }
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => value !== undefined && !dropped.has(name.toLowerCase())),
  ) as Record<string, T>;
}
