import { extract as tarExtract, pack as tarPack } from "tar-stream";

export async function makeTar(entries: Array<{ path: string; data: Uint8Array }>): Promise<Buffer> {
  const pack = tarPack();
  for (const entry of entries) {
    pack.entry({ name: entry.path, mode: 0o644, mtime: new Date(0) }, Buffer.from(entry.data));
  }
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function parseTar(raw: Uint8Array): Promise<Array<{ path: string; data: Buffer }>> {
  if (!raw.length) return [];
  const buf = Buffer.from(raw);
  if (buf.length < 1024 || buf.subarray(buf.length - 1024).some((byte) => byte !== 0)) {
    throw new Error("tar archive truncated: missing end-of-archive marker");
  }
  const entries: Array<{ path: string; data: Buffer }> = [];
  const extract = tarExtract();
  const done = new Promise<void>((resolve, reject) => {
    extract.on("finish", resolve);
    extract.on("error", reject);
  });
  extract.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      if (header.type === "file") entries.push({ path: header.name, data: Buffer.concat(chunks) });
      next();
    });
    stream.on("error", (err) => extract.destroy(err));
  });
  extract.end(buf);
  await done;
  return entries;
}
