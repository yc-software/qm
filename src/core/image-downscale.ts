import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const MAX_VISION_IMAGE_DIMENSION = 1568;

export interface ImageDimensions {
  width: number;
  height: number;
  format: "png" | "jpeg" | "gif" | "webp";
}

export interface ImageDownscaleDeps {
  spawn: (
    command: string,
    args: string[],
    options: { stdio: ["pipe", "pipe", "pipe"] },
  ) => ChildProcessWithoutNullStreams;
  warn: (message: string) => void;
}

const DEFAULT_DEPS: ImageDownscaleDeps = {
  spawn,
  warn: (message) => console.warn(message),
};

const FORMAT_BY_MIME = new Map<string, ImageDimensions["format"]>([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 24) return undefined;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((v, i) => bytes[i] === v)) return undefined;
  if (Buffer.from(bytes.subarray(12, 16)).toString("ascii") !== "IHDR") return undefined;
  return { width: Buffer.from(bytes).readUInt32BE(16), height: Buffer.from(bytes).readUInt32BE(20), format: "png" };
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 10) return undefined;
  const header = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
  if (header !== "GIF87a" && header !== "GIF89a") return undefined;
  return { width: Buffer.from(bytes).readUInt16LE(6), height: Buffer.from(bytes).readUInt16LE(8), format: "gif" };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset]!;
    offset++;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = Buffer.from(bytes).readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    const start = offset + 2;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (start + 5 > bytes.length) return undefined;
      return {
        width: Buffer.from(bytes).readUInt16BE(start + 3),
        height: Buffer.from(bytes).readUInt16BE(start + 1),
        format: "jpeg",
      };
    }
    offset += length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  if (Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "RIFF") return undefined;
  if (Buffer.from(bytes.subarray(8, 12)).toString("ascii") !== "WEBP") return undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = Buffer.from(bytes.subarray(offset, offset + 4)).toString("ascii");
    const length = Buffer.from(bytes).readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > bytes.length) return undefined;
    if (type === "VP8X" && length >= 10) {
      return { width: readUInt24LE(bytes, start + 4) + 1, height: readUInt24LE(bytes, start + 7) + 1, format: "webp" };
    }
    if (type === "VP8L" && length >= 5 && bytes[start] === 0x2f) {
      const b0 = bytes[start + 1]!;
      const b1 = bytes[start + 2]!;
      const b2 = bytes[start + 3]!;
      const b3 = bytes[start + 4]!;
      return {
        width: 1 + b0 + ((b1 & 0x3f) << 8),
        height: 1 + ((b1 & 0xc0) >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10),
        format: "webp",
      };
    }
    if (
      type === "VP8 " &&
      length >= 10 &&
      bytes[start + 3] === 0x9d &&
      bytes[start + 4] === 0x01 &&
      bytes[start + 5] === 0x2a
    ) {
      return {
        width: Buffer.from(bytes).readUInt16LE(start + 6) & 0x3fff,
        height: Buffer.from(bytes).readUInt16LE(start + 8) & 0x3fff,
        format: "webp",
      };
    }
    offset = start + length + (length % 2);
  }
  return undefined;
}

export function sniffImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  return pngDimensions(bytes) ?? jpegDimensions(bytes) ?? gifDimensions(bytes) ?? webpDimensions(bytes);
}

function imageMagickArgs(format: ImageDimensions["format"]): string[] {
  return ["-", "-resize", `${MAX_VISION_IMAGE_DIMENSION}x${MAX_VISION_IMAGE_DIMENSION}>`, `${format}:-`];
}

function ffmpegArgs(format: ImageDimensions["format"]): string[] {
  const codec = format === "jpeg" ? "mjpeg" : format;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-vf",
    `scale='if(gt(iw,ih),min(${MAX_VISION_IMAGE_DIMENSION},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_VISION_IMAGE_DIMENSION},ih))'`,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    codec,
    "pipe:1",
  ];
}

async function runConverter(
  bytes: Uint8Array,
  command: string,
  args: string[],
  deps: ImageDownscaleDeps,
): Promise<{ missing: boolean; output?: Uint8Array }> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { missing: boolean; output?: Uint8Array }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = deps.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      finish({ missing: (err as NodeJS.ErrnoException).code === "ENOENT" });
      return;
    }
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", (err: NodeJS.ErrnoException) => finish({ missing: err.code === "ENOENT" }));
    child.on("close", (code) => {
      if (code === 0) finish({ missing: false, output: Buffer.concat(stdout) });
      else finish({ missing: false });
    });
    child.stdin.end(Buffer.from(bytes));
  });
}

function outputIsUsable(bytes: Uint8Array): boolean {
  const dimensions = sniffImageDimensions(bytes);
  return (
    bytes.length > 0 &&
    (!dimensions || (dimensions.width <= MAX_VISION_IMAGE_DIMENSION && dimensions.height <= MAX_VISION_IMAGE_DIMENSION))
  );
}

export async function downscaleVisionImage(
  bytes: Uint8Array,
  mimeType: string,
  deps: ImageDownscaleDeps = DEFAULT_DEPS,
): Promise<Uint8Array> {
  const expectedFormat = FORMAT_BY_MIME.get(mimeType);
  if (!expectedFormat) return bytes;
  const dimensions = sniffImageDimensions(bytes);
  if (!dimensions) return bytes;
  if (dimensions.width <= MAX_VISION_IMAGE_DIMENSION && dimensions.height <= MAX_VISION_IMAGE_DIMENSION) return bytes;
  const attempts: Array<[string, string[]]> = [
    ["magick", imageMagickArgs(expectedFormat)],
    ["convert", imageMagickArgs(expectedFormat)],
    ["ffmpeg", ffmpegArgs(expectedFormat)],
  ];
  let sawConverter = false;
  for (const [command, args] of attempts) {
    const result = await runConverter(bytes, command, args, deps);
    if (!result.missing) sawConverter = true;
    if (result.output && outputIsUsable(result.output)) return result.output;
  }
  deps.warn(
    sawConverter
      ? "attachments: oversized image was not downscaled because image conversion failed"
      : "attachments: oversized image was not downscaled because no image converter was found on PATH",
  );
  return bytes;
}
