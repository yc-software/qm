import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CoreHandoff } from "../src/index.ts";

export interface CoreHit {
  lane: "handle" | "shell";
  method: string;
  url: string;
  cookie: string | null;
  headers: IncomingMessage["headers"];
  body: string;
}

async function answer(hits: CoreHit[], lane: CoreHit["lane"], req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const hit: CoreHit = {
    lane,
    method: req.method ?? "",
    url: req.url ?? "",
    cookie: req.headers.cookie ?? null,
    headers: req.headers,
    body: Buffer.concat(chunks).toString("utf8"),
  };
  hits.push(hit);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(hit));
}

export async function startWithFakeCore(
  serves: (method: string, pathname: string) => boolean = () => false,
): Promise<{ base: string; port: number; hits: CoreHit[]; close: () => void }> {
  const hits: CoreHit[] = [];
  const core: CoreHandoff = {
    serves,
    handle: (req, res) => void answer(hits, "handle", req, res),
    shell: (req, res) => answer(hits, "shell", req, res),
  };
  const { server, startServer } = await import("../src/index.ts");
  await startServer({ port: 0, core });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://localhost:${port}`, port, hits, close: () => server.close() };
}
