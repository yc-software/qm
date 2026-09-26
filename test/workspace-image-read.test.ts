import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { createExecSandboxBase } from "../src/sandbox/exec-sandbox-base.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4zwAE/0Ho/38GAB7vBPzpVsU+AAAAAElFTkSuQmCC",
  "base64",
);

const images: Record<string, string> = {
  png: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4zwAE/0Ho/38GAB7vBPzpVsU+AAAAAElFTkSuQmCC",
  jpeg: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAACf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJrgHoDe/9k=",
  gif: "R0lGODdhAgACAIEAABVqxwAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7",
  webp: "UklGRjwAAABXRUJQVlA4IDAAAADwAQCdASoCAAIAAUAmJaACdLoB+AAETAAA/vAb3/9cB+cB+cB/Mt/+fmd24v5zAAA=",
};

function setup(
  seed: Record<string, Uint8Array>,
  overrides: Partial<ToolContextDeps> = {},
  options: Partial<ToolContextRef> = {},
) {
  const paths: string[] = [];
  const stored = new Map(Object.entries(seed).map(([path, bytes]) => [`/workspace/${path}`, bytes]));
  const sandbox = createExecSandboxBase({
    homeDir: "/home/test",
    readAbsBytes: async (_name, path) => {
      paths.push(path);
      return stored.get(path) ?? null;
    },
    writeAbsBytes: async (_name, path, bytes) => {
      stored.set(path, bytes);
    },
  } as Parameters<typeof createExecSandboxBase>[0]);
  const context = createToolContext({
    sandbox: sandbox as unknown as Sandbox,
    provision: async () => ({ id: "test", rootDir: "/workspace" }),
    layers: [
      { scopeId: "personal:test", mountPath: "", mode: "rw" },
      { scopeId: "org:test", mountPath: "global", mode: "ro" },
    ],
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "test",
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    ...overrides,
  });
  const entries: unknown[] = [];
  const files = createAgentTools({
    current: context,
    scopeLabel: "personal:test",
    emit: (entry) => {
      entries.push(entry);
    },
    ...options,
  }).find((tool) => tool.name === "files")!;
  const read = (path: string) => files.execute("test", { action: "read", path }, undefined, undefined, {} as never);
  return { read, context, paths, stored, entries };
}

for (const [format, data] of Object.entries(images)) {
  test(`workspace ${format} reaches the agent as image content through the sandbox read path`, async () => {
    const path = `preview.${format}`;
    const { read, entries } = setup({ [path]: Buffer.from(data, "base64") });
    const result = await read(path);
    assert.deepEqual(result.content, [
      { type: "text", text: `[image: ${path}]` },
      { type: "image", mimeType: `image/${format}`, data },
    ]);
    assert.equal(JSON.stringify(entries).includes(data), false);
  });
}

test("image headers determine the MIME type regardless of the filename", async () => {
  const { read } = setup({ preview: png, "preview.jpg": png });
  for (const path of ["preview", "preview.jpg"])
    assert.deepEqual((await read(path)).content[1], {
      type: "image",
      mimeType: "image/png",
      data: png.toString("base64"),
    });
});

test("text, empty files, missing files and read-only mounts retain their behavior and scope", async () => {
  const { context, read, entries } = setup({
    "note.txt": Buffer.from("Hello, 世界\n"),
    "empty.txt": Buffer.alloc(0),
    "global/preview.png": png,
  });
  assert.equal((await context.read("note.txt")).content, "Hello, 世界\n");
  assert.equal((await context.read("empty.txt")).content, "");
  assert.equal((await context.read("absent.txt")).content, null);
  assert.equal((await read("preview.png")).content[1]?.type, "image");
  assert.equal((entries.at(-1) as { scopeLabel: string }).scopeLabel, "org:test");
});

test("invalid, empty, oversized and unsupported images never become binary model text", async () => {
  const oversized = Buffer.alloc(5_000_001);
  png.copy(oversized);
  const { read } = setup({
    "invalid.png": Buffer.from("not an image"),
    "empty.png": Buffer.alloc(0),
    "large.png": oversized,
    "unsupported.bmp": Buffer.from([0x42, 0x4d, 0, 255]),
  });
  for (const path of ["invalid.png", "empty.png"]) await assert.rejects(read(path), /Invalid image/);
  await assert.rejects(read("large.png"), /5000000-byte limit/);
  assert.match(JSON.stringify((await read("unsupported.bmp")).content), /binary file.*PNG, JPEG, GIF, or WebP/);
});

test("explicitly shared images retain external provenance and materialization", async () => {
  const { read, stored, entries } = setup(
    {},
    {
      grantedHandles: [
        {
          handlePath: "shared/preview.png",
          ownerPath: "preview.png",
          ownerScopeId: "personal:other",
          permission: "read",
        },
      ],
      workspace: { readBytes: async () => png } as never,
      sharedMaterializeDir: "shared/current",
    },
  );
  const result = await read("shared/preview.png");
  assert.equal(result.content[1]?.type, "image");
  assert.deepEqual(stored.get("/workspace/shared/current/preview.png"), png);
  assert.equal((entries.at(-1) as { scopeLabel: string }).scopeLabel, "personal:other");
});

test("Open carried images and unresolved Open paths cannot cross the binary sharing boundary", async () => {
  const { read, stored, paths } = setup(
    { "shared/open-other/preview.png": png },
    {
      grantedHandles: [
        {
          handlePath: "shared/open-other/preview.png",
          ownerPath: "preview.png",
          ownerScopeId: "personal:other",
          permission: "read",
          carried: true,
        },
      ],
      workspace: { readBytes: async () => png } as never,
    },
  );
  const result = await read("shared/open-other/preview.png");
  assert.equal(result.content.length, 1);
  assert.match(JSON.stringify(result.content), /explicit share/);
  assert.match(JSON.stringify((await read("shared/open-unknown/preview.png")).content), /no such file/);
  assert.equal(stored.size, 1);
  assert.deepEqual(paths, []);
});

test("image reads preserve path validation, tool approval and security quarantine", async () => {
  const image = { "preview.png": png };
  await assert.rejects(setup(image).read("../preview.png"), /stay inside the workspace/);
  const gated = setup(image, {}, { toolApprovalGate: () => false, pendingApprovals: [] });
  const blocked = await gated.read("preview.png");
  assert.equal(
    blocked.content.some((part) => part.type === "image"),
    false,
  );
  assert.deepEqual(gated.paths, []);
  let screened = false;
  const screenedRead = setup(
    image,
    {},
    {
      screenToolResult: async (input) => {
        assert.equal(input.unscreenable, true);
        assert.equal(input.sourceScopeId, "personal:test");
        screened = true;
        return { outcome: "quarantine" };
      },
    },
  );
  const result = await screenedRead.read("preview.png");
  assert.equal(screened, true);
  assert.equal(
    result.content.some((part) => part.type === "image"),
    false,
  );
  assert.match(JSON.stringify(result.content), /quarantined/);
});
