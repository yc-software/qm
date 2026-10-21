import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mintSignedPayload } from "../src/auth/signed-token.ts";

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
      response.end(JSON.stringify({ upload: { state: "pending", expiresAt: Date.now() + 60_000 } }));
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
      response.end(
        JSON.stringify({ upload: { state: complete ? "complete" : "pending", expiresAt: Date.now() + 60_000 } }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const source = join(directory, "empty.txt");
  await writeFile(source, "");
  let token =
    Buffer.from(JSON.stringify({ actorId: "user", scopeId: "personal:user" })).toString("base64url") + ".signature";
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        "python3",
        [fileURLToPath(new URL("../src/files/upload-client.py", import.meta.url)), source],
        {
          env: {
            ...process.env,
            AGENT_API_URL: origin,
            AGENT_API_TOKEN: token,
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
    token = await mintSignedPayload(
      {
        encoding: "deflate-raw",
        claims: deflateRawSync(JSON.stringify({ actorId: "user", scopeId: "personal:user" })).toString("base64url"),
      },
      "upload-test-secret",
    );
    enabled = false;
    complete = false;
    assert.equal(JSON.parse(await run()).file.id, "published");
    assert.equal(begins, 1);
    assert.equal(puts, 1);
    token = await mintSignedPayload(
      {
        encoding: "deflate-raw",
        claims: deflateRawSync(JSON.stringify({ actorId: "other", scopeId: "personal:other" })).toString("base64url"),
      },
      "upload-test-secret",
    );
    await assert.rejects(run(), /destination changed/);
    token = await mintSignedPayload(
      {
        encoding: "deflate-raw",
        claims: deflateRawSync("x".repeat(1024 * 1024 + 1)).toString("base64url"),
      },
      "upload-test-secret",
    );
    await assert.rejects(run(), /oversized capability/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("publisher cancels an unfinished upload when the file changed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-publisher-"));
  const requests: string[] = [];
  let origin = "";
  const server = createServer(async (request, response) => {
    for await (const _ of request) void _;
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    const url = request.url!;
    if (request.method === "DELETE") response.end(JSON.stringify({ ok: true }));
    else if (request.method === "PUT") response.end();
    else if (url === "/v1/files/uploads")
      response.end(JSON.stringify({ upload: { state: "pending", expiresAt: Date.now() + 60_000 } }));
    else if (url.endsWith("/parts/1")) response.end(JSON.stringify({ url: origin + "/part", headers: {} }));
    else if (url.endsWith("/complete")) response.end(JSON.stringify({ file: { id: "published" } }));
    else response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const source = join(directory, "state.md");
  const token =
    Buffer.from(JSON.stringify({ actorId: "user", scopeId: "personal:user" })).toString("base64url") + ".signature";
  await writeFile(source, "new contents");
  await writeFile(
    source + ".qm-upload.json",
    JSON.stringify({
      id: "a".repeat(32),
      manifest: { name: "state.md", mimetype: "text/markdown", sizeBytes: 3, checksums: ["old"] },
      destination: { origin, actor: "user", scope: "personal:user" },
      next: 1,
    }),
  );
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        "python3",
        [fileURLToPath(new URL("../src/files/upload-client.py", import.meta.url)), source],
        {
          env: { ...process.env, AGENT_API_URL: origin, AGENT_API_TOKEN: token },
          stdio: "ignore",
        },
      );
      child.on("error", reject);
      child.on("exit", resolve);
    });
    assert.equal(code, 0);
    assert.equal(requests[0], `DELETE /v1/files/uploads/${"a".repeat(32)}`);
    assert.ok(requests.includes("POST /v1/files/uploads"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("publisher starts a fresh upload when the saved session was aborted or expired", async () => {
  for (const saved of [{ state: "aborted" }, { state: "pending", expiresAt: 1 }]) {
    const directory = await mkdtemp(join(tmpdir(), "qm-publisher-"));
    const requests: string[] = [];
    let origin = "";
    const stale = "b".repeat(32);
    const server = createServer(async (request, response) => {
      for await (const _ of request) void _;
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      const url = request.url!;
      if (request.method === "DELETE") response.end(JSON.stringify({ ok: true }));
      else if (request.method === "PUT") response.end();
      else if (url === `/v1/files/uploads/${stale}`) response.end(JSON.stringify({ upload: saved }));
      else if (url === "/v1/files/uploads")
        response.end(JSON.stringify({ upload: { state: "pending", expiresAt: Date.now() + 60_000 } }));
      else if (url.endsWith("/parts/1")) response.end(JSON.stringify({ url: origin + "/part", headers: {} }));
      else if (url.endsWith("/complete")) response.end(JSON.stringify({ file: { id: "published" } }));
      else response.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    const source = join(directory, "note.txt");
    const token =
      Buffer.from(JSON.stringify({ actorId: "user", scopeId: "personal:user" })).toString("base64url") + ".signature";
    await writeFile(source, "abc");
    const checksum = createHash("sha256").update("abc").digest("base64");
    await writeFile(
      source + ".qm-upload.json",
      JSON.stringify({
        id: stale,
        manifest: { name: "note.txt", mimetype: "text/plain", sizeBytes: 3, checksums: [checksum] },
        destination: { origin, actor: "user", scope: "personal:user" },
        next: 1,
      }),
    );
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          "python3",
          [fileURLToPath(new URL("../src/files/upload-client.py", import.meta.url)), source],
          { env: { ...process.env, AGENT_API_URL: origin, AGENT_API_TOKEN: token }, stdio: "ignore" },
        );
        child.on("error", reject);
        child.on("exit", resolve);
      });
      assert.equal(code, 0);
      assert.ok(requests.includes("POST /v1/files/uploads"));
      assert.ok(!requests.includes(`POST /v1/files/uploads/${stale}/complete`));
      assert.ok(!requests.some((r) => r.startsWith("DELETE")));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("publisher shows what holds a full quota and can list and abort those uploads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qm-publisher-"));
  const requests: string[] = [];
  const stuck = "c".repeat(32);
  const listing = {
    uploads: [{ id: stuck, name: "stuck.bin", sizeBytes: 9, state: "pending", createdAt: 0, lastActivityAt: 60_000 }],
    elsewhere: 2,
  };
  const server = createServer(async (request, response) => {
    for await (const _ of request) void _;
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.method === "DELETE") response.end(JSON.stringify({ ok: true }));
    else if (request.method === "GET" && request.url === "/v1/files/uploads") response.end(JSON.stringify(listing));
    else if (request.method === "POST" && request.url === "/v1/files/uploads")
      response.writeHead(429).end(JSON.stringify({ error: "upload_quota", message: "quota is full", ...listing }));
    else response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const source = join(directory, "next.txt");
  await writeFile(source, "abc");
  const token =
    Buffer.from(JSON.stringify({ actorId: "user", scopeId: "personal:user" })).toString("base64url") + ".signature";
  const run = (...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      let out = "";
      const child = spawn(
        "python3",
        [fileURLToPath(new URL("../src/files/upload-client.py", import.meta.url)), ...args],
        {
          env: { ...process.env, AGENT_API_URL: origin, AGENT_API_TOKEN: token },
        },
      );
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, out }));
    });
  try {
    const refused = await run(source);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /quota is full/);
    assert.ok(refused.out.split("\n").some((line) => line.startsWith(stuck) && line.endsWith("stuck.bin")));
    assert.match(refused.out, /1970-01-01 00:01/);
    assert.match(refused.out, /2 more unfinished upload/);
    assert.match(refused.out, /--abort ID/);
    assert.equal(requests.filter((r) => r === "POST /v1/files/uploads").length, 1);

    const listed = await run("--list");
    assert.equal(listed.code, 0);
    assert.match(listed.out, /stuck\.bin/);

    assert.equal((await run("--abort", stuck)).code, 0);
    assert.ok(requests.includes(`DELETE /v1/files/uploads/${stuck}`));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
