import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  downscaleVisionImage,
  MAX_VISION_IMAGE_DIMENSION,
  sniffImageDimensions,
  type ImageDownscaleDeps,
} from "../src/core/image-downscale.ts";

interface SpawnCall {
  command: string;
  args: string[];
}

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(10);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function jpeg(width: number, height: number): Buffer {
  const bytes = Buffer.from("ffd8ffe000040000ffc0000b080000000001011100ffd9", "hex");
  bytes.writeUInt16BE(height, 13);
  bytes.writeUInt16BE(width, 15);
  return bytes;
}

function webp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes[24] = encodedWidth & 0xff;
  bytes[25] = (encodedWidth >> 8) & 0xff;
  bytes[26] = (encodedWidth >> 16) & 0xff;
  bytes[27] = encodedHeight & 0xff;
  bytes[28] = (encodedHeight >> 8) & 0xff;
  bytes[29] = (encodedHeight >> 16) & 0xff;
  return bytes;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function depsFromHandlers(
  handlers: Array<(child: FakeChild, call: SpawnCall) => void>,
  warnings: string[] = [],
  calls: SpawnCall[] = [],
): ImageDownscaleDeps {
  return {
    spawn(command, args) {
      const child = fakeChild();
      const call = { command, args };
      calls.push(call);
      const handler = handlers.shift();
      process.nextTick(() => handler?.(child, call));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    warn(message) {
      warnings.push(message);
    },
  };
}

test("sniffImageDimensions reads PNG, JPEG, GIF, and WebP headers", () => {
  assert.deepEqual(sniffImageDimensions(png(640, 480)), { width: 640, height: 480, format: "png" });
  assert.deepEqual(sniffImageDimensions(jpeg(800, 600)), { width: 800, height: 600, format: "jpeg" });
  assert.deepEqual(sniffImageDimensions(gif(320, 240)), { width: 320, height: 240, format: "gif" });
  assert.deepEqual(sniffImageDimensions(webp(1024, 768)), { width: 1024, height: 768, format: "webp" });
});

test("downscaleVisionImage leaves small images untouched without spawning a converter", async () => {
  const small = png(MAX_VISION_IMAGE_DIMENSION, 900);
  let spawned = false;
  const result = await downscaleVisionImage(small, "image/png", {
    spawn() {
      spawned = true;
      return fakeChild() as unknown as ChildProcessWithoutNullStreams;
    },
    warn() {
      assert.fail("small images should not warn");
    },
  });
  assert.equal(result, small);
  assert.equal(spawned, false);
});

test("downscaleVisionImage uses a converter for oversized images", async () => {
  const output = png(1200, 900);
  const calls: SpawnCall[] = [];
  const deps = depsFromHandlers(
    [
      (child) => {
        child.stdout.end(output);
        child.emit("close", 0);
      },
    ],
    [],
    calls,
  );
  const result = await downscaleVisionImage(png(2400, 1800), "image/png", deps);
  assert.deepEqual(Buffer.from(result), output);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, "magick");
  assert.ok(calls[0]!.args.includes(`${MAX_VISION_IMAGE_DIMENSION}x${MAX_VISION_IMAGE_DIMENSION}>`));
  assert.ok(calls[0]!.args.includes("png:-"));
});

test("downscaleVisionImage falls back to original bytes when no converter is available", async () => {
  const original = png(3000, 2000);
  const warnings: string[] = [];
  const calls: SpawnCall[] = [];
  const missing = (child: FakeChild) => {
    const err = new Error("missing") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    child.emit("error", err);
  };
  const deps = depsFromHandlers([missing, missing, missing], warnings, calls);
  const result = await downscaleVisionImage(original, "image/png", deps);
  assert.equal(result, original);
  assert.deepEqual(
    calls.map((c) => c.command),
    ["magick", "convert", "ffmpeg"],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /no image converter was found on PATH/);
});
