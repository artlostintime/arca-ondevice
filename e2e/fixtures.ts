/**
 * E2E fixtures. Builds real file bytes the app must detect and convert.
 * The minimal docx is a valid OOXML package (stored ZIP, no compression) so
 * the office pipeline (anydoc-wasm) is exercised end to end.
 */

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(dv: DataView, off: number, v: number): void {
  dv.setUint16(off, v, true);
}
function u32(dv: DataView, off: number, v: number): void {
  dv.setUint32(off, v >>> 0, true);
}

/** Build a stored-method (no compression) ZIP from named entries. */
function makeZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const body: Uint8Array[] = [];
  const central: { name: Uint8Array; offset: number; size: number; crc: number }[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const lfh = new DataView(new ArrayBuffer(30));
    u32(lfh, 0, 0x04034b50);
    u16(lfh, 4, 20);
    u16(lfh, 6, 0);
    u16(lfh, 8, 0);
    u16(lfh, 10, 0);
    u16(lfh, 12, 0);
    u32(lfh, 14, crc);
    u32(lfh, 18, e.data.length);
    u32(lfh, 22, e.data.length);
    u16(lfh, 26, nameBytes.length);
    u16(lfh, 28, 0);
    body.push(new Uint8Array(lfh.buffer), nameBytes, e.data);
    central.push({ name: nameBytes, offset, size: e.data.length, crc });
    offset += 30 + nameBytes.length + e.data.length;
  }
  const cdStart = offset;
  const cd: Uint8Array[] = [];
  for (const c of central) {
    const cdf = new DataView(new ArrayBuffer(46));
    u32(cdf, 0, 0x02014b50);
    u16(cdf, 4, 20);
    u16(cdf, 6, 20);
    u16(cdf, 8, 0);
    u16(cdf, 10, 0);
    u16(cdf, 12, 0);
    u16(cdf, 14, 0);
    u32(cdf, 16, c.crc);
    u32(cdf, 20, c.size);
    u32(cdf, 24, c.size);
    u16(cdf, 28, c.name.length);
    u16(cdf, 30, 0);
    u16(cdf, 32, 0);
    u16(cdf, 34, 0);
    u16(cdf, 36, 0);
    u32(cdf, 38, 0);
    u32(cdf, 42, c.offset);
    cd.push(new Uint8Array(cdf.buffer), c.name);
  }
  const cdSize = cd.reduce((a, b) => a + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  u32(eocd, 0, 0x06054b50);
  u16(eocd, 4, 0);
  u16(eocd, 6, 0);
  u16(eocd, 8, entries.length);
  u16(eocd, 10, entries.length);
  u32(eocd, 12, cdSize);
  u32(eocd, 16, cdStart);
  u16(eocd, 20, 0);

  const out = new Uint8Array(cdStart + cdSize + 22);
  let p = 0;
  for (const part of [...body, ...cd, new Uint8Array(eocd.buffer)]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_BODY = (text: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`;

/** A valid minimal .docx containing the given visible text. */
export function makeDocx(text: string): Uint8Array {
  return makeZip([
    { name: '[Content_Types].xml', data: new TextEncoder().encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: new TextEncoder().encode(RELS) },
    { name: 'word/document.xml', data: new TextEncoder().encode(DOC_BODY(text)) },
  ]);
}
