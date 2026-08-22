import { createHash } from "node:crypto";

export interface ZipEntry {
  readonly path: string;
  readonly bytes: Buffer;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertPath(path: string): void {
  if (path.length === 0 || path.length > 240 || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError("ZIP entry path is unsafe.");
  }
}

function localHeader(path: Buffer, bytes: Buffer): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(crc32(bytes), 14);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(path.length, 26);
  return Buffer.concat([header, path]);
}

function centralHeader(path: Buffer, bytes: Buffer, offset: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(crc32(bytes), 16);
  header.writeUInt32LE(bytes.length, 20);
  header.writeUInt32LE(bytes.length, 24);
  header.writeUInt16LE(path.length, 28);
  header.writeUInt32LE((0o100600 << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, path]);
}

export function deterministicZip(input: readonly ZipEntry[], maximumBytes: number): Buffer {
  const entries = [...input].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(entries.map(({ path }) => path)).size !== entries.length) throw new TypeError("ZIP entry paths must be unique.");
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    assertPath(entry.path);
    const path = Buffer.from(entry.path, "utf8");
    const header = localHeader(path, entry.bytes);
    local.push(header, entry.bytes);
    central.push(centralHeader(path, entry.bytes, offset));
    offset += header.length + entry.bytes.length;
    if (offset > maximumBytes) throw new Error("Export exceeds the approved bounded size.");
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  const output = Buffer.concat([...local, centralBytes, end]);
  if (output.length > maximumBytes) throw new Error("Export exceeds the approved bounded size.");
  return output;
}

export function zipSha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
