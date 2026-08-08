import { describe, expect, it } from 'vitest';
import { detectFile } from '../src/lib/filetype';

function head(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

describe('detectFile', () => {
  it('classifies an empty file as unsupported', () => {
    const r = detectFile(new Uint8Array(0));
    expect(r.category).toBe('unsupported');
    expect(r.format).toBe('empty');
  });

  it('detects PDF by magic bytes', () => {
    const bytes = head(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34);
    const r = detectFile(bytes);
    expect(r.category).toBe('document');
    expect(r.format).toBe('pdf');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('detects PNG by magic bytes', () => {
    const bytes = head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const r = detectFile(bytes);
    expect(r.category).toBe('image');
    expect(r.format).toBe('png');
  });

  it('detects WAV audio', () => {
    const bytes = new Uint8Array(44);
    bytes.set([0x52, 0x49, 0x46, 0x46]); // RIFF
    bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    const r = detectFile(bytes);
    expect(r.category).toBe('audio');
    expect(r.format).toBe('wav');
  });

  it('treats non-ZIP non-signature content as unknown, not trusting extension', () => {
    const r = detectFile(new Uint8Array([1, 2, 3, 4, 5]), 'important.pdf');
    expect(r.category).toBe('unknown');
  });

  it('detects plain text content', () => {
    const r = detectFile(new TextEncoder().encode('hello world\nsecond line'));
    expect(r.category).toBe('text');
  });

  it('detects CSV by extension when content is text', () => {
    const r = detectFile(new TextEncoder().encode('a,b,c\n1,2,3'), 'data.csv');
    expect(r.category).toBe('document');
    expect(r.format).toBe('csv');
  });

  it('routes OLE compound documents (.doc/.ppt/.xls) to the doc pipeline', () => {
    const bytes = head(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    const r = detectFile(bytes);
    expect(r.category).toBe('document');
    expect(r.format).toBe('ole');
  });

  it('flags HEIC images with a decode warning', () => {
    const bytes = new Uint8Array(16);
    bytes.set([0x00, 0x00, 0x00, 0x18]); // box size
    bytes.set(new TextEncoder().encode('ftyp'), 4);
    bytes.set(new TextEncoder().encode('heic'), 8);
    const r = detectFile(bytes);
    expect(r.category).toBe('image');
    expect(r.format).toBe('heic');
    expect(r.reason).toBeTruthy();
  });

  it('flags unsupported containers with a reason', () => {
    const bytes = head(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20);
    const r = detectFile(bytes);
    expect(r.category).toBe('unsupported');
    expect(r.reason).toBeTruthy();
  });
});
