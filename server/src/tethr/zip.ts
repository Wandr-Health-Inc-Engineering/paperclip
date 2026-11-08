import zlib from "node:zlib";

// A small zip reader and writer for Office files (phase 22): Excel workbooks
// tethr makes, and the text inside Word, Excel and PowerPoint files people
// attach. Deflate or stored entries only, no encryption, no zip64; that covers
// every .docx/.xlsx/.pptx Office and Google export.

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
const STORED = 0;

/** A deflated zip archive of the given files, in order. */
export function writeZip(entries: ZipEntry[], now: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const packed = zlib.deflateRawSync(entry.data);
    const crc = zlib.crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_NAMES, 8);
    header.writeUInt16LE(DEFLATE, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + packed.length;
  }
  const centralBytes = central.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

export interface ZipLimits {
  /** Most entries read from one archive. */
  entries: number;
  /** Most bytes one entry may unpack to (a small zip can expand enormously). */
  entryBytes: number;
}

const DEFAULT_LIMITS: ZipLimits = { entries: 5_000, entryBytes: 40 * 1024 * 1024 };

/** The files in a zip archive by name; each unpacks only when read. Throws on
 * anything that isn't a plain zip. */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_LIMITS): Map<string, () => Buffer> {
  const endAt = findEndOfCentral(buf);
  const count = buf.readUInt16LE(endAt + 10);
  if (count > limits.entries) throw new Error("too many files in the archive");
  let at = buf.readUInt32LE(endAt + 16);
  const files = new Map<string, () => Buffer>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_HEADER) throw new Error("damaged archive");
    const method = buf.readUInt16LE(at + 10);
    const packedSize = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    files.set(name, () => unpack(buf, localAt, packedSize, method, limits.entryBytes));
  }
  return files;
}

function unpack(buf: Buffer, localAt: number, packedSize: number, method: number, maxBytes: number): Buffer {
  if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL_HEADER) throw new Error("damaged archive");
  const start = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
  const packed = buf.subarray(start, start + packedSize);
  if (method === STORED) {
    if (packed.length > maxBytes) throw new Error("a file in the archive is too large");
    return Buffer.from(packed);
  }
  if (method !== DEFLATE) throw new Error("unsupported compression in the archive");
  try {
    return zlib.inflateRawSync(packed, { maxOutputLength: maxBytes });
  } catch (err) {
    if (err instanceof RangeError) throw new Error("a file in the archive is too large");
    throw err;
  }
}

function findEndOfCentral(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === END_OF_CENTRAL) return i;
  }
  throw new Error("not a zip archive");
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
