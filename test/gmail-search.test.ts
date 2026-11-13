import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const SCRIPT = join(process.cwd(), "skills-seed", "google-workspace", "scripts", "gmail.py");
const havePython = spawnSync("python3", ["--version"]).status === 0;
const ids = Array.from({ length: 45 }, (_, i) => `m${i}`);
const row = (id: string) => ({ id, threadId: `t-${id}`, from: null, date: null, subject: id, snippet: `about ${id}` });

function batchReply(requested: string[], limited: Set<string>): string {
  const parts = requested.map((id) => {
    const refused = limited.delete(id);
    const body = refused
      ? { error: { code: 429, message: "Too many concurrent requests for user." } }
      : { id, threadId: `t-${id}`, snippet: `about ${id}`, payload: { headers: [{ name: "Subject", value: id }] } };
    const status = refused ? "429 Too Many Requests" : "200 OK";
    return `--reply\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 ${status}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\r\n`;
  });
  return `${parts.join("")}--reply--\r\n`;
}

test("search fetches listed messages in batches and retries rate-limited ones", { skip: !havePython }, async () => {
  const batches: number[] = [];
  const limited = new Set(["m7"]);
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const call = JSON.parse(raw) as { url: string; body?: string };
      const path = new URL(call.url).pathname;
      if (path.endsWith("/users/me/messages")) return res.end(JSON.stringify({ messages: ids.map((id) => ({ id })) }));
      if (path !== "/batch/gmail/v1") return res.writeHead(500).end("{}");
      const marker = "Content-ID: <";
      const lines = call.body!.split("\r\n").filter((line) => line.startsWith(marker));
      const requested = lines.map((line) => line.slice(marker.length, -1));
      batches.push(requested.length);
      res.writeHead(200, { "content-type": "multipart/mixed; boundary=reply" }).end(batchReply(requested, limited));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const env = { PATH: process.env.PATH, AGENT_API_URL: `http://127.0.0.1:${port}`, AGENT_API_TOKEN: "cap" };
  try {
    const args = [SCRIPT, "search", "newer_than:14d", "--limit", "100"];
    const { stdout } = await promisify(execFile)("python3", args, { env });
    const listed = stdout.trim().split("\n");
    assert.deepEqual(
      listed.map((line) => JSON.parse(line) as unknown),
      ids.map(row),
    );
    assert.deepEqual(batches, [20, 20, 5, 1]);
  } finally {
    server.close();
  }
});
