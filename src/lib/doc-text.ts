/**
 * Pure text helpers for document conversion. No browser/DOM dependencies, so
 * they are directly unit-testable in Node.
 */

/** Decode a text/CSV file, honoring BOMs. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(start ? bytes.subarray(start) : bytes);
}

const PAGE_MARKER = /<!--\s*Page\s+(\d+)\s*-->/g;

/**
 * Merge the PDF text-layer markdown with per-page OCR text. pdf-inspector
 * emits `<!-- Page N -->` markers; OCR'd pages (scanned/mixed) have their
 * text inserted at the right marker so page order is preserved. If the
 * markdown has no markers, the OCR text is simply appended after it.
 * Never returns blank for a scanned PDF (each flagged page contributes).
 */
export function mergePdfText(
  markdown: string | undefined,
  pageCount: number,
  ocrByPage: Map<number, string>,
): string {
  const base = markdown ?? '';
  const sections = new Map<number, string>();
  PAGE_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  let lastPage = 0;
  let last = 0;
  let found = false;
  while ((m = PAGE_MARKER.exec(base))) {
    found = true;
    const page = Number(m[1]);
    if (lastPage) sections.set(lastPage, base.slice(last, m.index));
    lastPage = page;
    last = PAGE_MARKER.lastIndex;
  }
  if (lastPage) sections.set(lastPage, base.slice(last));

  const out: string[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const section = sections.get(p)?.trim() ?? '';
    const ocr = ocrByPage.get(p)?.trim() ?? '';
    if (!found) {
      // No markers in the source markdown; preserve it once, then OCR text.
      out.push(base.trim());
      found = true;
      if (ocr) out.push(`\n\n<!-- OCR page ${p} -->\n\n${ocr}`);
      continue;
    }
    out.push(`<!-- Page ${p} -->`);
    if (section) out.push(section);
    if (ocr) out.push(`\n\n<!-- OCR -->\n\n${ocr}`);
  }
  return out.join('\n\n');
}
