/**
 * Minimal ZIP central-directory reader. Enough to classify ZIP-based office
 * packages (docx/pptx/xlsx/odt/ods/odp/epub) without inflating anything.
 */

export interface ZipEntry {
  name: string;
  method: number;
  localOffset: number;
  compressedSize: number;
  size: number;
}

const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_ENTRIES = 200000;

function u16(dv: DataView, o: number): number {
  return dv.getUint16(o, true);
}

function u32(dv: DataView, o: number): number {
  return dv.getUint32(o, true);
}

function nameAt(bytes: Uint8Array, start: number, len: number): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start, start + len));
  } catch {
    return '';
  }
}

/** Returns the central-directory entry list, or null when this is not a ZIP. */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] | null {
  if (bytes.length < 22) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End of central directory: scan the last 64KB + 22 bytes.
  let eocd = -1;
  const min = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (
      bytes[i] === 0x50 && bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const totalEntries = u16(dv, eocd + 10);
  const cdOffset = u32(dv, eocd + 16);
  if (totalEntries > MAX_ENTRIES) return null;

  const entries: ZipEntry[] = [];
  let pos = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (pos + 46 > bytes.length) return null;
    if (u32(dv, pos) !== CEN_SIG) return null;
    const method = u16(dv, pos + 10);
    const compressedSize = u32(dv, pos + 20);
    const size = u32(dv, pos + 24);
    const nameLen = u16(dv, pos + 28);
    const extraLen = u16(dv, pos + 30);
    const commentLen = u16(dv, pos + 32);
    const localOffset = u32(dv, pos + 42);
    const nameStart = pos + 46;
    if (nameStart + nameLen > bytes.length) return null;
    entries.push({
      name: nameAt(bytes, nameStart, nameLen),
      method,
      localOffset,
      compressedSize,
      size,
    });
    pos = nameStart + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Read the raw bytes of an entry that is stored uncompressed (method 0).
 * Returns null when the entry is compressed or malformed.
 */
export function readStoredEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array | null {
  if (entry.method !== 0) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.localOffset;
  if (p + 30 > bytes.length) return null;
  if (u32(dv, p) !== LOC_SIG) return null;
  const nameLen = u16(dv, p + 26);
  const extraLen = u16(dv, p + 28);
  const start = p + 30 + nameLen + extraLen;
  if (start + entry.size > bytes.length) return null;
  return bytes.slice(start, start + entry.size);
}
