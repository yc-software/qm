import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("publisher resumes an existing transfer after new uploads are disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-publisher-"));
  let initiated = false;
  let enabled = true;
  let complete = false;
  let begins = 0;
  let puts = 0;
  let origin = "";
  const server = createServer(async (request, response) => {
    for await (const _ of request) void _;
    response.setHeader("content-type", "application/json");
    const url = request.url!;
    if (url === "/v1/files/uploads") {
      begins++;
      if (!enabled) {
        response.writeHead(503).end("{}");
        return;
      }
      initiated = true;
      response.end(JSON.stringify({ upload: { state: "pending" } }));
    } else if (request.method === "PUT") {
      puts++;
      response.end();
    } else if (url.endsWith("/parts/1")) {
      response.end(JSON.stringify({ url: origin + "/part", headers: {} }));
    } else if (url.endsWith("/complete")) {
      complete = true;
      response.end(JSON.stringify({ file: { id: "published" }, contentUrl: "/file" }));
    } else {
      if (!initiated) {
        response.writeHead(404).end("{}");
        return;
      }
      response.end(JSON.stringify({ upload: { state: complete ? "complete" : "pending" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const source = join(directory, "empty.txt");
  await writeFile(source, "");
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        "python3",
        [fileURLToPath(new URL("../src/files/upload-client.py", import.meta.url)), source],
        {
          env: {
            ...process.env,
            AGENT_API_URL: origin,
            AGENT_API_TOKEN:
              Buffer.from(JSON.stringify({ actorId: "user", scopeId: "personal:user" })).toString("base64url") +
              ".signature",
          },
        },
      );
      let output = "",
        errors = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        errors += data;
      });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(errors))));
    });
  try {
    assert.equal(JSON.parse(await run()).file.id, "published");
    enabled = false;
    complete = false;
    assert.equal(JSON.parse(await run()).file.id, "published");
    assert.equal(begins, 1);
    assert.equal(puts, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
