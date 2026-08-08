/**
 * File router. Detects the real content of a file from magic bytes / ZIP
 * package structure, never trusting extension or MIME type alone.
 */
import { readZipEntries, readStoredEntry } from './zip';

export type Category =
  | 'document'
  | 'image'
  | 'audio'
  | 'video'
  | 'text'
  | 'unsupported'
  | 'unknown';

export interface FileTypeInfo {
  category: Category;
  /** Canonical format key, e.g. 'docx', 'pdf', 'png', 'mp4', 'wav'. */
  format: string;
  /** 0..1 */
  confidence: number;
  /** Human label, e.g. "Word document". */
  label: string;
  /** Set when category is 'unsupported' / 'unknown'. */
  reason?: string;
}

function ascii(bytes: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && off + i < bytes.length; i++) {
    s += String.fromCharCode(bytes[off + i]);
  }
  return s;
}

function startsWith(bytes: Uint8Array, seq: number[] | string, off = 0): boolean {
  const s = typeof seq === 'string' ? Array.from(seq, (c) => c.charCodeAt(0)) : seq;
  if (off + s.length > bytes.length) return false;
  for (let i = 0; i < s.length; i++) if (bytes[off + i] !== s[i]) return false;
  return true;
}

function info(
  category: Category,
  format: string,
  label: string,
  confidence: number,
  reason?: string,
): FileTypeInfo {
  return { category, format, label, confidence, reason };
}

function detectZip(bytes: Uint8Array): FileTypeInfo | null {
  const isZip =
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
  if (!isZip) return null;

  const entries = readZipEntries(bytes);
  const names = entries ? new Set(entries.map((e) => e.name)) : new Set<string>();
  const mimetype = entries ? entries.find((e) => e.name === 'mimetype') : undefined;

  if (mimetype && mimetype.method === 0) {
    const data = readStoredEntry(bytes, mimetype);
    if (data) {
      const t = ascii(data, 0, data.length).trim();
      if (t === 'application/epub+zip') return info('document', 'epub', 'EPUB ebook', 0.99);
      if (t === 'application/vnd.oasis.opendocument.text')
        return info('document', 'odt', 'OpenDocument text', 0.99);
      if (t === 'application/vnd.oasis.opendocument.spreadsheet')
        return info('document', 'ods', 'OpenDocument spreadsheet', 0.99);
      if (t === 'application/vnd.oasis.opendocument.presentation')
        return info('document', 'odp', 'OpenDocument presentation', 0.99);
    }
  }

  if (names.has('word/document.xml')) return info('document', 'docx', 'Word document', 0.99);
  if (names.has('ppt/presentation.xml'))
    return info('document', 'pptx', 'PowerPoint presentation', 0.99);
  if (names.has('xl/workbook.xml')) return info('document', 'xlsx', 'Excel workbook', 0.99);

  return info(
    'unsupported',
    'zip',
    'ZIP archive (unrecognized package)',
    0.5,
    'Unsupported archive, or a password-protected Office file that cannot be opened.',
  );
}

function sniffText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  // BOMs
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return true; // UTF-8
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return true; // UTF-16
  const n = Math.min(bytes.length, 2048);
  let printable = 0;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e) || b >= 0x80) printable++;
    else control++;
  }
  if (control / n > 0.05) return false;
  return printable / n > 0.85;
}

export function detectFile(bytes: Uint8Array, fileName?: string): FileTypeInfo {
  if (!bytes || bytes.byteLength === 0) {
    return info('unsupported', 'empty', 'Empty file', 1, 'This file is empty (0 bytes).');
  }
  if (startsWith(bytes, '%PDF-')) return info('document', 'pdf', 'PDF document', 0.99);
  if (startsWith(bytes, '{\\rtf')) return info('document', 'rtf', 'Rich Text Format', 0.99);

  const zip = detectZip(bytes);
  if (zip) return zip;

  // Images
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return info('image', 'png', 'PNG image', 0.99);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return info('image', 'jpeg', 'JPEG image', 0.99);
  if (startsWith(bytes, 'GIF87a') || startsWith(bytes, 'GIF89a'))
    return info('image', 'gif', 'GIF image', 0.98);
  if (startsWith(bytes, 'BM')) return info('image', 'bmp', 'BMP image', 0.98);
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]))
    return info('image', 'tiff', 'TIFF image', 0.98);
  if (startsWith(bytes, 'RIFF') && ascii(bytes, 8, 4) === 'WEBP')
    return info('image', 'webp', 'WebP image', 0.99);

  // ISO BMFF (MP4/MOV/M4A/HEIC)
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    const lc = brand.toLowerCase();
    if (['heic', 'heix', 'heif', 'mif1', 'hevc'].includes(lc))
      return info('image', 'heic', 'HEIC image', 0.6, 'HEIC may not render in this browser.');
    if (['m4a ', 'm4b ', 'mp4a'].includes(brand))
      return info('audio', 'm4a', 'AAC/M4A audio', 0.9);
    if (brand === 'qt  ') return info('video', 'mov', 'QuickTime video', 0.9);
    return info('video', 'mp4', 'MP4 video/audio', 0.9);
  }

  // Audio
  if (startsWith(bytes, 'RIFF') && ascii(bytes, 8, 4) === 'WAVE')
    return info('audio', 'wav', 'WAV audio', 0.99);
  if (startsWith(bytes, 'FORM') && ascii(bytes, 8, 4) === 'AIFF')
    return info('audio', 'aiff', 'AIFF audio', 0.99);
  if (startsWith(bytes, 'fLaC')) return info('audio', 'flac', 'FLAC audio', 0.99);
  if (startsWith(bytes, 'OggS')) return info('audio', 'ogg', 'Ogg audio', 0.9);
  if (startsWith(bytes, 'ID3')) return info('audio', 'mp3', 'MP3 audio', 0.99);
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    return info('audio', 'mp3', 'MP3 audio', 0.9);

  // Video containers
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]))
    return info('video', 'webm', 'WebM/Matroska video', 0.9);
  if (startsWith(bytes, 'RIFF') && ascii(bytes, 8, 4) === 'AVI ')
    return info('unsupported', 'avi', 'AVI video', 0.9, 'AVI audio extraction is not supported in browsers.');
  if (startsWith(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]))
    return info('unsupported', 'wmv', 'WMV/ASF video', 0.9, 'WMV audio extraction is not supported in browsers.');

  // OLE compound documents (.doc / .ppt / .xls) — anydoc parses these.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return info('document', 'ole', 'OLE compound document', 0.9);

  // Plain text / CSV
  if (sniffText(bytes)) {
    const ext = fileName ? fileName.split('.').pop()?.toLowerCase() : '';
    if (ext === 'csv') return info('document', 'csv', 'CSV file', 0.8);
    return info('text', 'text', 'Plain text', 0.8);
  }

  return info('unknown', 'unknown', 'Unrecognized file', 0.2, 'This file type is not supported.');
}
