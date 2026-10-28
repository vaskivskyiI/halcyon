// Minimal ZIP: writing (stored, no compression — mail is mostly compressed already) as a stream, with ZIP64 for
// archives over 4 GB or 65535 files; reading (stored and deflated entries) from a file without loading it whole.
import fs from 'node:fs';
import zlib from 'node:zlib';

const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = zlib.crc32 || ((buf) => { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; });

function dos(date) {
  const d = new Date(Math.max(date || Date.now(), Date.UTC(1980, 0, 2)));
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
const MAX32 = 0xffffffff;

/** entries: (async) iterable of { name, data: Buffer, date }. Yields the ZIP file in pieces. */
export async function* zipStream(entries) {
  const central = [];
  let offset = 0;
  for await (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const { time, date } = dos(e.date);
    const crc = crc32(e.data), size = e.data.length;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(size, 18); h.writeUInt32LE(size, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    central.push({ name, crc, size, time, date, offset });
    yield h; yield name; yield e.data;
    offset += 30 + name.length + size;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const big = c.offset >= MAX32;
    const extra = big ? Buffer.alloc(12) : Buffer.alloc(0);
    if (big) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(c.offset), 4); }
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(45, 4); h.writeUInt16LE(big ? 45 : 20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(0, 10);
    h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14); h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.size, 20); h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28); h.writeUInt16LE(extra.length, 30); h.writeUInt32LE(big ? MAX32 : c.offset, 42);
    yield h; yield c.name; if (extra.length) yield extra;
    cdSize += 46 + c.name.length + extra.length;
  }
  const z64 = central.length > 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
  if (z64) {
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0); r.writeBigUInt64LE(44n, 4); r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14);
    r.writeBigUInt64LE(BigInt(central.length), 24); r.writeBigUInt64LE(BigInt(central.length), 32); r.writeBigUInt64LE(BigInt(cdSize), 40); r.writeBigUInt64LE(BigInt(cdStart), 48);
    const l = Buffer.alloc(20);
    l.writeUInt32LE(0x07064b50, 0); l.writeBigUInt64LE(BigInt(cdStart + cdSize), 8); l.writeUInt32LE(1, 16);
    yield r; yield l;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(central.length, 0xffff), 8); end.writeUInt16LE(Math.min(central.length, 0xffff), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12); end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
  yield end;
}

/** The entries of a ZIP file: [{ name, size, read(): Buffer }] (directories left out). */
export function zipEntries(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const readAt = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
  const tailLen = Math.min(size, 65557);
  const tail = readAt(size - tailLen, tailLen);
  const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0) { fs.closeSync(fd); throw new Error('Not a ZIP file'); }
  let count = tail.readUInt16LE(at + 10), cdSize = tail.readUInt32LE(at + 12), cdStart = tail.readUInt32LE(at + 16);
  const loc = at - 20;
  if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
    const r = readAt(Number(tail.readBigUInt64LE(loc + 8)), 56);
    count = Number(r.readBigUInt64LE(32)); cdSize = Number(r.readBigUInt64LE(40)); cdStart = Number(r.readBigUInt64LE(48));
  }
  const cd = readAt(cdStart, cdSize);
  const out = [];
  for (let p = 0, i = 0; i < count && p < cd.length; i++) {
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // ZIP64 sizes / offset, in this order, for the fields that are full.
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let q = 0; q + 4 <= extra.length;) {
      const id = extra.readUInt16LE(q), len = extra.readUInt16LE(q + 2);
      if (id === 0x0001) {
        let r = q + 4;
        if (usize === MAX32) { usize = Number(extra.readBigUInt64LE(r)); r += 8; }
        if (csize === MAX32) { csize = Number(extra.readBigUInt64LE(r)); r += 8; }
        if (offset === MAX32) { offset = Number(extra.readBigUInt64LE(r)); }
      }
      q += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    out.push({
      name, size: usize,
      read: () => {
        const h = readAt(offset, 30);
        const data = readAt(offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28), csize);
        if (method === 0) return data;
        if (method === 8) return zlib.inflateRawSync(data);
        throw new Error(`Unsupported compression in ${name}`);
      },
    });
  }
  out.close = () => fs.closeSync(fd);
  return out;
}
