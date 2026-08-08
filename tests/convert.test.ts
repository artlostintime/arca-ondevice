import { describe, expect, it } from 'vitest';
import { decodeText, mergePdfText } from '../src/lib/doc-text';

function u8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('decodeText', () => {
  it('decodes plain UTF-8', () => {
    expect(decodeText(u8('hello world'))).toBe('hello world');
  });

  it('strips a UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...u8('café')]);
    expect(decodeText(bytes)).toBe('café');
  });

  it('decodes UTF-16LE with BOM', () => {
    // "hi" in UTF-16LE with BOM
    const bytes = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    expect(decodeText(bytes)).toBe('hi');
  });

  it('decodes UTF-16BE with BOM', () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
    expect(decodeText(bytes)).toBe('hi');
  });
});

describe('mergePdfText', () => {
  it('inserts OCR text at the matching page marker', () => {
    const md = '<!-- Page 1 -->\n\nHello from page one.\n\n<!-- Page 2 -->\n\n';
    const ocr = new Map<number, string>([[2, 'Scan text here.']]);
    const out = mergePdfText(md, 2, ocr);
    expect(out).toContain('<!-- Page 2 -->');
    expect(out).toContain('Scan text here.');
    expect(out).toContain('Hello from page one.');
  });

  it('never returns blank for a fully-scanned PDF', () => {
    const ocr = new Map<number, string>([[1, 'Page one scan.'], [2, 'Page two scan.']]);
    const out = mergePdfText(undefined, 2, ocr);
    expect(out).toContain('Page one scan.');
    expect(out).toContain('Page two scan.');
    expect(out.length).toBeGreaterThan(0);
  });

  it('appends OCR text when markdown has no page markers', () => {
    const md = 'Some extracted text without markers.';
    const ocr = new Map<number, string>([[1, 'OCR page 1.'], [2, 'OCR page 2.']]);
    const out = mergePdfText(md, 2, ocr);
    expect(out).toContain(md);
    expect(out).toContain('OCR page 1.');
    expect(out).toContain('OCR page 2.');
  });

  it('combines text-layer and OCR text on the same page', () => {
    const md = '<!-- Page 1 -->\n\nPartial text.\n\n<!-- Page 2 -->\n\n';
    const ocr = new Map<number, string>([[1, 'Image text.']]);
    const out = mergePdfText(md, 2, ocr);
    expect(out).toContain('Partial text.');
    expect(out).toContain('Image text.');
  });
});
