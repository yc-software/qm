import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { sleep } from "../util/async.ts";

export interface FlyPrivateTunnel {
  port: number;
  stop(): Promise<void>;
  isAlive(): boolean;
}

export async function startFlyPrivateTunnel(opts: {
  executable: string;
  wireguardConfig: string;
  port?: number;
}): Promise<FlyPrivateTunnel> {
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535))
    throw new Error("Fly tunnel requires a valid local port");
  if (
    /^\s*\[(?:Socks5|HTTP|TCPClientTunnel|TCPServerTunnel|UDPClientTunnel|UDPServerTunnel)\]/im.test(
      opts.wireguardConfig,
    )
  )
    throw new Error("Fly peer configuration must not contain forwarding listeners");
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string")
        return listener.close(() => reject(new Error("Fly tunnel port allocation failed")));
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  const directory = await mkdtemp(join(tmpdir(), "qm-fly-tunnel-"));
  const path = join(directory, "wireproxy.conf");
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  let dead = false;
  const stop = async () => {
    if (child && !dead) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => {
        if (!dead) child!.kill("SIGKILL");
      }, 2000);
      await exited;
      clearTimeout(kill);
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await writeFile(path, `${opts.wireguardConfig}\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n`, { mode: 0o600 });
    child = spawn(opts.executable, ["-c", path], { stdio: "ignore" });
    exited = new Promise<void>((resolve) => {
      child!.once("exit", () => {
        dead = true;
        resolve();
      });
      child!.once("error", () => {
        dead = true;
        resolve();
      });
    });
    for (let i = 0; i < 100; i++) {
      if (dead) throw new Error("Fly private tunnel exited before becoming ready");
      const listening = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.setTimeout(100);
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => {
          socket.destroy();
          resolve(false);
        });
        socket.once("timeout", () => {
          socket.destroy();
          resolve(false);
        });
      });
      if (listening && !dead) return { port, stop, isAlive: () => !dead };
      await sleep(100);
    }
    throw new Error("Fly private tunnel did not become ready");
  } catch (error) {
    await stop();
    throw error;
  }
}
