import { crc32, deflateRawSync } from "node:zlib";

export function skillZip(
  entries: Array<{
    path: string;
    text?: string;
    bytes?: Buffer;
    mode?: number;
    flags?: number;
    size?: number;
    crc?: number;
  }>,
): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const bytes = entry.bytes ?? Buffer.from(entry.text ?? "");
    const compressed = deflateRawSync(bytes);
    const checksum = entry.crc ?? crc32(bytes);
    const size = entry.size ?? bytes.length;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(entry.flags ?? 0x800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(checksum, 14);
    head.writeUInt32LE(compressed.length, 18);
    head.writeUInt32LE(size, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(entry.flags ?? 0x800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? (entry.path.endsWith("/") ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += head.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
