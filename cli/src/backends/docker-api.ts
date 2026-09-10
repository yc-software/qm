import { execFileSync, spawn } from "node:child_process";
import { request, validateHeaderName, validateHeaderValue } from "node:http";
import { Duplex } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { CliError } from "../log.ts";
import { isEnvVarName } from "../util.ts";

export interface DockerContainer {
  name: string;
  image: string;
  network: string;
  aliases: string[];
  labels: Record<string, string>;
  env: Record<string, string>;
  headers?: Record<string, string>;
  binds?: string[];
  groups?: string[];
  port?: { host: number; container: number };
}

function customHeadersFromEnv(value: string): Record<string, string> {
  if (/[\r\n]/.test(value)) throw new Error();
  const headers: Record<string, string> = {};
  const field = /("(?:[^"]|"")*"|[^",]*)(,|$)/y;
  for (;;) {
    const match = field.exec(value);
    if (!match) throw new Error();
    const entry = match[1]!.startsWith('"') ? match[1]!.slice(1, -1).replaceAll('""', '"') : match[1]!;
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error();
    const name = entry.slice(0, separator).trim().toLowerCase();
    headers[name] = entry.slice(separator + 1);
    if (match[2] !== ",") return headers;
  }
}

export function dockerClientDefaults(): { env: Record<string, string>; headers: Record<string, string> } {
  const path = join(process.env.DOCKER_CONFIG || join(homedir(), ".docker"), "config.json");
  try {
    const config = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as {
      HttpHeaders?: Record<string, string>;
      proxies?: Record<string, Record<string, string>>;
    };
    const headers = process.env.DOCKER_CUSTOM_HEADERS
      ? customHeadersFromEnv(process.env.DOCKER_CUSTOM_HEADERS)
      : Object.fromEntries(Object.entries(config.HttpHeaders ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== "string") throw new Error();
      validateHeaderName(key);
      validateHeaderValue(key, value);
    }
    if (process.env.DOCKER_API_VERSION && !/^\d+\.\d+$/.test(process.env.DOCKER_API_VERSION)) throw new Error();
    const proxies = config.proxies ?? {};
    let proxy = proxies.default ?? {};
    if (Object.keys(proxies).some((key) => key !== "default")) {
      const host = JSON.parse(
        execFileSync("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
        }),
      );
      proxy = proxies[host] ?? proxy;
    }
    const env: Record<string, string> = {};
    for (const [key, name] of Object.entries({
      httpProxy: "HTTP_PROXY",
      httpsProxy: "HTTPS_PROXY",
      ftpProxy: "FTP_PROXY",
      allProxy: "ALL_PROXY",
      noProxy: "NO_PROXY",
    })) {
      if (typeof proxy[key] === "string" && proxy[key] !== "") {
        env[name] = proxy[key];
        env[name.toLowerCase()] = proxy[key];
      }
    }
    return { env, headers };
  } catch {
    throw new CliError("Cannot read Docker client defaults; diagnostic output withheld because it may contain secrets");
  }
}

export function validateDockerEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!isEnvVarName(key)) throw new CliError("container environment contains an invalid variable name");
    if (value.includes("\0")) throw new CliError(`container environment variable ${key} contains a NUL byte`);
  }
}

interface ApiRequest {
  path: string;
  body: object;
  expectedStatus: number;
  headers?: Record<string, string>;
}

function dockerRequest(
  path: string,
  body: object,
  expectedStatus: number,
  headers?: Record<string, string>,
): string | undefined {
  let result: { id?: string; error?: string };
  try {
    result = JSON.parse(
      execFileSync(process.execPath, [import.meta.filename], {
        input: JSON.stringify({
          path: process.env.DOCKER_API_VERSION
            ? `/v${encodeURIComponent(process.env.DOCKER_API_VERSION)}${path}`
            : path,
          body,
          expectedStatus,
          headers,
        }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }),
    );
  } catch {
    throw new CliError("Docker API request failed; diagnostic output withheld because it may contain secrets");
  }
  if (result.error) throw new CliError(result.error);
  return result.id;
}

async function requestThroughDocker({ path, body, expectedStatus, headers }: ApiRequest): Promise<{ id?: string }> {
  const child = spawn("docker", ["system", "dial-stdio"], { stdio: ["pipe", "pipe", "ignore"] });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const socket = Duplex.from({ readable: child.stdout, writable: child.stdin });
  try {
    return await new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const req = request(
        {
          signal: controller.signal,
          hostname: "docker",
          path,
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(json),
            connection: "close",
          },
          createConnection: () => socket as Socket,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024) res.destroy(new Error("response too large"));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            if (res.statusCode !== expectedStatus) {
              reject(
                new CliError(
                  `Docker API request failed (HTTP ${res.statusCode}); response body withheld because it may contain secrets`,
                ),
              );
              return;
            }
            if (expectedStatus !== 201) {
              resolve({});
              return;
            }
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (typeof result.Id !== "string" || !/^[a-f0-9]{64}$/.test(result.Id)) throw new Error();
              resolve({ id: result.Id });
            } catch {
              reject(new CliError("Docker API returned an invalid container identity"));
            }
          });
        },
      );
      req.on("error", () => reject(new Error("Docker API connection failed")));
      child.on("error", () => req.destroy());
      req.on("finish", () => child.stdin.end());
      req.end(json);
    });
  } finally {
    clearTimeout(timer);
    socket.destroy();
    child.kill("SIGKILL");
  }
}

if (process.argv[1] === import.meta.filename) {
  try {
    const options = JSON.parse(readFileSync(0, "utf8")) as ApiRequest;
    const result = await requestThroughDocker(options);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const message =
      error instanceof CliError
        ? error.message
        : "Docker API request failed; diagnostic output withheld because it may contain secrets";
    process.stdout.write(JSON.stringify({ error: message }));
  }
}

export function startDockerContainer(container: DockerContainer): void {
  validateDockerEnv(container.env);
  const port = container.port ? `${container.port.container}/tcp` : undefined;
  const [apiMajor = 1, apiMinor = 41] = (process.env.DOCKER_API_VERSION ?? "1.41").split(".").map(Number);
  const platform = apiMajor > 1 || apiMinor >= 41 ? process.env.DOCKER_DEFAULT_PLATFORM : undefined;
  const id = dockerRequest(
    `/containers/create?name=${encodeURIComponent(container.name)}${platform ? `&platform=${encodeURIComponent(platform)}` : ""}`,
    {
      Image: container.image,
      Env: Object.entries(container.env).map(([key, value]) => `${key}=${value}`),
      Labels: container.labels,
      ...(port ? { ExposedPorts: { [port]: {} } } : {}),
      HostConfig: {
        NetworkMode: container.network,
        RestartPolicy: { Name: "no" },
        Binds: container.binds ?? [],
        GroupAdd: container.groups ?? [],
        ...(port ? { PortBindings: { [port]: [{ HostIp: "", HostPort: String(container.port!.host) }] } } : {}),
      },
      NetworkingConfig: { EndpointsConfig: { [container.network]: { Aliases: container.aliases } } },
    },
    201,
    container.headers,
  );
  dockerRequest(`/containers/${id}/start`, {}, 204, container.headers);
}
