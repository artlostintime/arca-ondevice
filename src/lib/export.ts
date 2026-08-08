/**
 * Batch export helpers — 100% client-side, no dependencies.
 * A minimal stored-method (no compression) ZIP writer, plus a combined
 * Markdown builder and zip-entry filename sanitizing/dedup.
 */
import type { ConversionResult } from './result';

export interface ZipFile {
  name: string;
  data: Uint8Array;
}

// --- CRC-32 (IEEE, as used by ZIP) ---
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(dv: DataView, o: number, v: number): void {
  dv.setUint16(o, v, true);
}
function u32(dv: DataView, o: number, v: number): void {
  dv.setUint32(o, v >>> 0, true);
}

/**
 * Build a stored-method ZIP archive from named byte blobs. The layout mirrors
 * the one understood by readZipEntries/readStoredEntry in lib/zip.ts, so the
 * reader can round-trip verify this writer in tests.
 */
export function buildZip(files: ZipFile[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: { name: Uint8Array; offset: number; crc: number; size: number }[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lfh = new Uint8Array(30);
    const dv = new DataView(lfh.buffer);
    u32(dv, 0, 0x04034b50);
    u16(dv, 4, 20); // version needed
    u16(dv, 6, 0); // flags
    u16(dv, 8, 0); // method: stored
    u16(dv, 10, 0); // mod time
    u16(dv, 12, 0); // mod date
    u32(dv, 14, crc);
    u32(dv, 18, f.data.length);
    u32(dv, 22, f.data.length);
    u16(dv, 26, name.length);
    u16(dv, 28, 0); // extra len
    locals.push(lfh, name, f.data);
    central.push({ name, offset, crc, size: f.data.length });
    offset += 30 + name.length + f.data.length;
  }
  const cdStart = offset;
  const cd: Uint8Array[] = [];
  for (const c of central) {
    const cdf = new Uint8Array(46);
    const dv = new DataView(cdf.buffer);
    u32(dv, 0, 0x02014b50);
    u16(dv, 4, 20); // version made by
    u16(dv, 6, 20); // version needed
    u16(dv, 8, 0); // flags
    u16(dv, 10, 0); // method
    u16(dv, 12, 0); // mod time
    u16(dv, 14, 0); // mod date
    u32(dv, 16, c.crc);
    u32(dv, 20, c.size);
    u32(dv, 24, c.size);
    u16(dv, 28, c.name.length);
    u16(dv, 30, 0); // extra len
    u16(dv, 32, 0); // comment len
    u16(dv, 34, 0); // disk number start
    u16(dv, 36, 0); // internal attrs
    u32(dv, 38, 0); // external attrs
    u32(dv, 42, c.offset);
    cd.push(cdf, c.name);
  }
  const cdSize = cd.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  u32(dv, 0, 0x06054b50);
  u16(dv, 4, 0); // disk number
  u16(dv, 6, 0); // disk with cd
  u16(dv, 8, files.length);
  u16(dv, 10, files.length);
  u32(dv, 12, cdSize);
  u32(dv, 16, cdStart);
  u16(dv, 20, 0); // comment len

  const out = new Uint8Array(cdStart + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...cd, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const UNSAFE = /[\u0000-\u001f\u007f/\\<>:"|?*]/g;

/** Map a converted file to a safe zip-entry name: <stem>.md, unicode-safe. */
export function zipEntryName(fileName: string): string {
  const cleaned = fileName
    .replace(UNSAFE, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 240);
  const dot = cleaned.lastIndexOf('.');
  const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned) || 'converted';
  return `${stem}.md`;
}

/** De-duplicate entry names so no two files collide in the archive. */
export function uniqueZipNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = seen.get(n) ?? 0;
    seen.set(n, count + 1);
    return count === 0 ? n : n.replace(/\.md$/, ` (${count}).md`);
  });
}

/** Concatenate successful conversions into a single Markdown document. */
export function combinedMarkdown(results: ConversionResult[]): string {
  const ok = results.filter((r) => r.status === 'ok');
  const parts: string[] = [];
  for (const r of ok) {
    parts.push(`## ${r.fileName}`, '', r.markdown.trim());
  }
  return parts.length ? parts.join('\n\n') + '\n' : '';
}
