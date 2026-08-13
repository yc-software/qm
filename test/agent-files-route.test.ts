import "./support/auto-fake-sprites.ts";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { contentTypeWithUtf8Charset } from "../src/api/http.ts";
import { fileArtifactId } from "../src/files/file-artifact-store.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "agent-files-secret".repeat(3);

it("detects charset parameters outside quoted parameter values", () => {
  assert.equal(
    contentTypeWithUtf8Charset('text/plain; note="x;charset=bogus"'),
    'text/plain; note="x;charset=bogus"; charset=utf-8',
  );
  assert.equal(
    contentTypeWithUtf8Charset("text/plain; format=flowed; charset=iso-8859-1"),
    "text/plain; format=flowed; charset=iso-8859-1",
  );
  assert.equal(
    contentTypeWithUtf8Charset("text/plain; format=flowed; ChArSeT = utf-16"),
    "text/plain; format=flowed; ChArSeT = utf-16",
  );
  assert.equal(contentTypeWithUtf8Charset('text/plain; note="one;two"'), 'text/plain; note="one;two"; charset=utf-8');
});

describe("agent files self-API", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let mineId: string;
  let theirsId: string;
  let encodedId: string;
  let binaryId: string;

  const capFor = (actorId: string) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );

  const get = async (path: string, token?: string) =>
    fetch(`${base}${path}`, { headers: token ? { "x-agent-capability": token } : {} });

  before(async () => {
    built = buildApp(testConfig({ signingSecret: SECRET }));
    server = createServer(built.app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    mineId = fileArtifactId("mine", "out", 0);
    theirsId = fileArtifactId("theirs", "out", 0);
    encodedId = fileArtifactId("encoded", "out", 0);
    binaryId = fileArtifactId("binary", "out", 0);
    await built.files.put({
      id: mineId,
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      name: "mine.txt",
      path: `artifacts/${mineId}/mine.txt`,
      mimetype: "text/plain",
      data: Buffer.from("mine"),
      direction: "out",
    });
    await built.files.put({
      id: theirsId,
      ownerScopeId: scopeId("personal", "U2"),
      createdBy: "U2",
      name: "theirs.txt",
      path: `artifacts/${theirsId}/theirs.txt`,
      mimetype: "text/plain",
      data: Buffer.from("theirs"),
      direction: "out",
    });
    await built.files.put({
      id: encodedId,
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      name: "encoded.json",
      path: `artifacts/${encodedId}/encoded.json`,
      mimetype: "application/json; charset=iso-8859-1",
      data: Buffer.from("{}"),
      direction: "out",
    });
    await built.files.put({
      id: binaryId,
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      name: "binary.png",
      path: `artifacts/${binaryId}/binary.png`,
      mimetype: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      direction: "out",
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("requires a capability token", async () => {
    assert.equal((await get("/v1/files")).status, 401);
  });

  it("lists only files visible to the capability actor", async () => {
    const res = await get("/v1/files", await capFor("U1"));
    assert.equal(res.status, 200);
    const page = (await res.json()) as { owned: Array<{ id: string }>; shared: Array<{ id: string }> };
    assert.deepEqual(page.owned.map((file) => file.id).sort(), [mineId, encodedId, binaryId].sort());
    assert.deepEqual(page.shared, []);
  });

  it("returns 404 for another principal's file content", async () => {
    const res = await get(`/v1/files/${theirsId}/content`, await capFor("U1"));
    assert.equal(res.status, 404);
  });

  it("adds UTF-8 to textual file content without changing explicit charsets or binary types", async () => {
    const token = await capFor("U1");
    const text = await get(`/v1/files/${mineId}/content`, token);
    const encoded = await get(`/v1/files/${encodedId}/content`, token);
    const binary = await get(`/v1/files/${binaryId}/content`, token);

    assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(encoded.headers.get("content-type"), "application/json; charset=iso-8859-1");
    assert.equal(binary.headers.get("content-type"), "image/png");
    await Promise.all([text.arrayBuffer(), encoded.arrayBuffer(), binary.arrayBuffer()]);
  });
});
