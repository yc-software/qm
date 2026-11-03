import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { appPrefixOf, type QmConfig } from "../config.ts";
import { CoreUnreachableError } from "../deployment-layer.ts";
import { fetchCoreAt, type CoreLink } from "../operator-request.ts";
import { flyBin, sleep } from "../util.ts";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("port"))));
    });
  });

const accepts = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

export async function flyCoreLink(config: QmConfig, timeoutMs = 30_000): Promise<CoreLink> {
  const port = await freePort();
  const app = `${appPrefixOf(config)}-core`;
  const child = spawn(flyBin(), ["proxy", `${port}:8080`, "-a", app], { stdio: "ignore" });
  const close = (): void => void child.kill();
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(250)) {
    if (child.exitCode !== null) break;
    if (await accepts(port)) return { request: fetchCoreAt(`http://127.0.0.1:${port}`), close };
  }
  close();
  throw new CoreUnreachableError(`could not open a private fly proxy to ${app}`);
}
