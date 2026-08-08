import { describe, expect, it } from 'vitest';
import { buildZip, combinedMarkdown, uniqueZipNames, zipEntryName } from '../src/lib/export';
import { readStoredEntry, readZipEntries } from '../src/lib/zip';
import type { ConversionResult } from '../src/lib/result';

function u8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function result(fileName: string, markdown: string, status: 'ok' | 'error' = 'ok'): ConversionResult {
  return {
    id: crypto.randomUUID(),
    fileName,
    detected: { category: 'document', format: 'md', confidence: 1, label: 'Text' },
    markdown,
    metadata: { engine: 'text', fallbacksUsed: [], durationMs: 1, sizeBytes: markdown.length },
    warnings: [],
    createdAt: Date.now(),
    status,
    ...(status === 'error' ? { error: { code: 'x', message: 'nope' } } : {}),
  };
}

describe('buildZip', () => {
  it('produces a ZIP readable by the existing reader with matching names and sizes', () => {
    const zip = buildZip([
      { name: 'a.md', data: u8('hello') },
      { name: 'b.md', data: u8('world') },
    ]);
    const entries = readZipEntries(zip);
    expect(entries).not.toBeNull();
    expect(entries!.map((e) => e.name)).toEqual(['a.md', 'b.md']);
    expect(entries!.map((e) => e.size)).toEqual([5, 5]);
  });

  it('round-trips stored entry contents', () => {
    const zip = buildZip([{ name: 'x.md', data: u8('some content here') }]);
    const entries = readZipEntries(zip)!;
    const data = readStoredEntry(zip, entries[0]);
    expect(new TextDecoder().decode(data!)).toBe('some content here');
  });

  it('handles unicode and empty content', () => {
    const zip = buildZip([
      { name: 'hindi.md', data: u8('हिन्दी') },
      { name: 'empty.md', data: new Uint8Array(0) },
    ]);
    const entries = readZipEntries(zip)!;
    expect(entries).toHaveLength(2);
    expect(new TextDecoder().decode(readStoredEntry(zip, entries[0])!)).toBe('हिन्दी');
    expect(readStoredEntry(zip, entries[1])).toHaveLength(0);
  });
});

describe('zipEntryName', () => {
  it('rewrites the stem to a .md entry name', () => {
    expect(zipEntryName('notes.txt')).toBe('notes.md');
    expect(zipEntryName('report.pdf')).toBe('report.md');
    expect(zipEntryName('already.md')).toBe('already.md');
  });

  it('keeps unicode stems and sanitizes unsafe characters', () => {
    expect(zipEntryName('रिपोर्ट.pdf')).toBe('रिपोर्ट.md');
    expect(zipEntryName('a/b\\c:*.txt')).toBe('a_b_c_.md');
  });

  it('falls back to a safe name for pathological inputs', () => {
    expect(zipEntryName('...')).toBe('converted.md');
    expect(zipEntryName('')).toBe('converted.md');
  });
});

describe('uniqueZipNames', () => {
  it('de-duplicates collisions with a numeric suffix', () => {
    expect(uniqueZipNames(['a.md', 'a.md', 'b.md'])).toEqual(['a.md', 'a (1).md', 'b.md']);
  });

  it('passes through distinct names unchanged', () => {
    expect(uniqueZipNames(['a.md', 'b.md'])).toEqual(['a.md', 'b.md']);
  });
});

describe('combinedMarkdown', () => {
  it('concatenates ok results with filename headings', () => {
    const md = combinedMarkdown([result('one.txt', 'First body'), result('two.txt', 'Second body')]);
    expect(md).toContain('## one.txt');
    expect(md).toContain('First body');
    expect(md).toContain('## two.txt');
    expect(md).toContain('Second body');
  });

  it('skips errored conversions', () => {
    const md = combinedMarkdown([result('bad.txt', '', 'error'), result('good.txt', 'ok body')]);
    expect(md).not.toContain('bad.txt');
    expect(md).toContain('good.txt');
  });

  it('returns an empty string when nothing succeeded', () => {
    expect(combinedMarkdown([])).toBe('');
    expect(combinedMarkdown([result('bad.txt', '', 'error')])).toBe('');
  });
});
