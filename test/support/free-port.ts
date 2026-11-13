import { createServer } from "node:net";

const firstEphemeralPort = 32_768;

export async function freePort(): Promise<number> {
  const port = 1_024 + Math.floor(Math.random() * (firstEphemeralPort - 1_024));
  const probe = createServer();
  const free = await new Promise<boolean>((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!free) return freePort();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
