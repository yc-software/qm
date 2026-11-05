import { Readable } from "node:stream";
import type { WebReleases } from "../server/index.ts";

export function releaseFiles(files: Record<string, string | Buffer>): WebReleases {
  const read = (name: string): Buffer | undefined => {
    const body = files[name];
    return body === undefined ? undefined : Buffer.from(body);
  };
  return {
    async document(name) {
      const body = read(name);
      if (!body) throw new Error(`fixture release has no ${name}`);
      return body.toString("utf8");
    },
    async file(path, gzip) {
      const packed = gzip ? read(`${path}.gz`) : undefined;
      if (packed) return { body: Readable.from(packed), gzip: true };
      const plain = read(path);
      return plain ? { body: Readable.from(plain), gzip: false } : null;
    },
  };
}
