import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AWS_PRIVATE_CORE_OBJECT_MAX_BYTES,
  AWS_PRIVATE_CORE_OVERRIDES_MAX_BYTES,
  AWS_PRIVATE_CORE_REQUEST_BODY_MAX_BYTES,
  AWS_PRIVATE_CORE_RESPONSE_MAX_BYTES,
  awsPrivateCoreKeys,
  awsPrivateCoreRequestBody,
  awsPrivateCoreTaskScript,
  awsPrivateSecretValidation,
  parseAwsPrivateCoreResponse,
} from "../src/aws-private-core-request.ts";

test("private secret validation is silent and maps invalid values without exposing them", () => {
  const validation = awsPrivateSecretValidation(
    ["PUBLIC_API_URL", "CORE_SIGNING_SECRET", "ADMIN_GRANTS"],
    "https://agent.acme.example/",
  );
  const run = (env: Record<string, string>) =>
    spawnSync(validation.command[0]!, validation.command.slice(1), {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        ...Object.fromEntries(validation.environment.map((item) => [item.name, item.value])),
      },
    });
  const valid = {
    ADMIN_GRANTS: "ops@example.com:org_admin",
    CORE_SIGNING_SECRET: "a".repeat(32),
    PUBLIC_API_URL: "https://agent.acme.example/",
  };
  const passed = run(valid);
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, "");
  assert.equal(passed.stderr, "");
  for (const [name, value] of [
    ["ADMIN_GRANTS", "ops@example.com:viewer"],
    ["CORE_SIGNING_SECRET", "short"],
    ["PUBLIC_API_URL", "https://wrong.example"],
  ] as const) {
    const failed = run({ ...valid, [name]: value });
    assert.equal(validation.invalidSecret(failed.status ?? undefined), name);
    assert.equal(failed.stdout, "");
    assert.equal(failed.stderr, "");
  }
  assert.doesNotMatch(JSON.stringify(validation), /ops@example|a{32}/);
});

test("private core request envelopes are deterministic and bounded", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(awsPrivateCoreKeys(id), {
    request: `deployment/core-requests/${id}/request.json`,
    response: `deployment/core-requests/${id}/response.json`,
  });
  assert.deepEqual(JSON.parse(awsPrivateCoreRequestBody("GET", "")), { version: 1, method: "GET", body: "" });
  assert.deepEqual(JSON.parse(awsPrivateCoreRequestBody("PUT", "payload")), {
    version: 1,
    method: "PUT",
    body: "payload",
  });
  assert.throws(() => awsPrivateCoreRequestBody("GET", "payload"), /body is invalid/);
  assert.throws(
    () => awsPrivateCoreRequestBody("PUT", "x".repeat(AWS_PRIVATE_CORE_REQUEST_BODY_MAX_BYTES + 1)),
    /body is invalid/,
  );
});

test("private core response envelopes expose only typed bounded terminal results", () => {
  assert.deepEqual(
    parseAwsPrivateCoreResponse(JSON.stringify({ version: 1, ok: true, status: 200, body: "payload" })),
    { version: 1, ok: true, status: 200, body: "payload" },
  );
  assert.deepEqual(parseAwsPrivateCoreResponse(JSON.stringify({ version: 1, ok: true, status: 503, body: "" })), {
    version: 1,
    ok: true,
    status: 503,
    body: "",
  });
  assert.deepEqual(parseAwsPrivateCoreResponse(JSON.stringify({ version: 1, ok: false, code: "core_unavailable" })), {
    version: 1,
    ok: false,
    code: "core_unavailable",
  });
  for (const value of [
    { version: 1, ok: true, status: 199, body: "" },
    { version: 1, ok: true, status: 503, body: "private failure" },
    { version: 1, ok: true, status: 200, body: "", extra: true },
    { version: 1, ok: false, code: "arbitrary_failure" },
  ]) {
    assert.throws(() => parseAwsPrivateCoreResponse(JSON.stringify(value)), /response object is invalid/);
  }
  assert.throws(
    () =>
      parseAwsPrivateCoreResponse(
        JSON.stringify({
          version: 1,
          ok: true,
          status: 200,
          body: "x".repeat(AWS_PRIVATE_CORE_RESPONSE_MAX_BYTES + 1),
        }),
      ),
    /response object is (?:invalid|too large)/,
  );
  assert.throws(
    () => parseAwsPrivateCoreResponse("x".repeat(AWS_PRIVATE_CORE_OBJECT_MAX_BYTES + 1)),
    /response object is too large/,
  );
});

test("private core task signing stays inside a bounded sanitized ECS override", () => {
  const script = awsPrivateCoreTaskScript();
  const overrides = JSON.stringify({
    containerOverrides: [
      {
        name: "core",
        command: ["node", "-e", script],
        environment: [
          { name: "QM_AWS_CORE_REQUEST_BUCKET", value: "qm-object-store-123456789012-us-west-2" },
          { name: "QM_AWS_CORE_REQUEST_ID", value: "123e4567-e89b-42d3-a456-426614174000" },
          { name: "QM_AWS_CORE_REQUEST_URL", value: "http://core.acme.internal:8080" },
        ],
      },
    ],
  });
  assert.ok(Buffer.byteLength(overrides) <= AWS_PRIVATE_CORE_OVERRIDES_MAX_BYTES);
  assert.match(script, /CORE_SIGNING_SECRET/);
  assert.match(script, /createHmac/);
  assert.match(script, /\/v1\/deployment-layer/);
  assert.doesNotMatch(
    script,
    /get-secret-value|SecretString|console\.log|error\.message|String\(error\)|JSON\.stringify\(error\)/,
  );
});

test("private core task signs in-process and publishes a sanitized terminal response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-private-core-task-"));
  const moduleDir = join(dir, "node_modules", "@aws-sdk", "client-s3");
  const requestFile = join(dir, "request.json");
  const responseFile = join(dir, "response.json");
  const deletedFile = join(dir, "deleted.txt");
  const signingSecret = "private-signing-value";
  const serverDetail = "do-not-expose-server-detail";
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(
    join(moduleDir, "index.js"),
    `const fs=require("node:fs");
class GetObjectCommand{constructor(input){this.input=input}}
class PutObjectCommand{constructor(input){this.input=input}}
class DeleteObjectCommand{constructor(input){this.input=input}}
class S3Client{async send(command){if(command instanceof GetObjectCommand){const body=fs.readFileSync(process.env.QM_TEST_REQUEST_FILE);return{ContentLength:body.length,Body:{transformToByteArray:async()=>body}}}if(command instanceof PutObjectCommand){fs.writeFileSync(process.env.QM_TEST_RESPONSE_FILE,String(command.input.Body));return{}}if(command instanceof DeleteObjectCommand){fs.writeFileSync(process.env.QM_TEST_DELETED_FILE,command.input.Key);return{}}throw new Error("unexpected command")}}
module.exports={S3Client,GetObjectCommand,PutObjectCommand,DeleteObjectCommand};
`,
  );
  writeFileSync(requestFile, awsPrivateCoreRequestBody("PUT", "payload"));
  let captured: { body: string; path: string; signature: string; timestamp: string } | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      captured = {
        body: Buffer.concat(chunks).toString("utf8"),
        path: request.url ?? "",
        signature: String(request.headers["x-signature"] ?? ""),
        timestamp: String(request.headers["x-timestamp"] ?? ""),
      };
      response.statusCode = 503;
      response.end(serverDetail);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, ["-e", awsPrivateCoreTaskScript()], {
        cwd: dir,
        env: {
          ...process.env,
          CORE_SIGNING_SECRET: signingSecret,
          QM_AWS_CORE_REQUEST_BUCKET: "bucket",
          QM_AWS_CORE_REQUEST_ID: "123e4567-e89b-42d3-a456-426614174000",
          QM_AWS_CORE_REQUEST_URL: `http://127.0.0.1:${port}`,
          QM_TEST_DELETED_FILE: deletedFile,
          QM_TEST_REQUEST_FILE: requestFile,
          QM_TEST_RESPONSE_FILE: responseFile,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("close", (code) => resolve({ code, stderr, stdout }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(captured);
    assert.equal(captured.path, "/v1/deployment-layer");
    assert.equal(captured.body, "payload");
    const canonical = `PUT\n/v1/deployment-layer\npayload`;
    const expected = createHmac("sha256", signingSecret).update(`v0:${captured.timestamp}:${canonical}`).digest("hex");
    assert.equal(captured.signature, `v0=${expected}`);
    assert.deepEqual(JSON.parse(readFileSync(responseFile, "utf8")), {
      version: 1,
      ok: true,
      status: 503,
      body: "",
    });
    assert.match(readFileSync(deletedFile, "utf8"), /request\.json$/);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}\n${readFileSync(responseFile, "utf8")}`,
      new RegExp(`${signingSecret}|${serverDetail}`),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
