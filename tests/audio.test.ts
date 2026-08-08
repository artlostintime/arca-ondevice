import { describe, expect, it } from 'vitest';
import { chunkAudio, decodeToPcm16k, decodeWavSamples, isWav, resampleTo16k, stitch, stitchAll, SAMPLE_RATE } from '../src/lib/audio';

function wavBytes(opts: { channels?: number; rate?: number; bits?: number; format?: number; samples: number[] }): ArrayBuffer {
  const { channels = 1, rate = 16000, bits = 16, format = 1, samples } = opts;
  const bytesPerSample = bits / 8;
  const dataLen = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const w = (s: string, o: number) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w('RIFF', 0); dv.setUint32(4, 36 + dataLen, true); w('WAVE', 8);
  w('fmt ', 12); dv.setUint32(16, 16, true); dv.setUint16(20, format, true); // 1=PCM, 3=IEEE float
  dv.setUint16(22, channels, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * channels * bytesPerSample, true);
  dv.setUint16(32, channels * bytesPerSample, true); dv.setUint16(34, bits, true);
  w('data', 36); dv.setUint32(40, dataLen, true);
  let p = 44;
  for (const s of samples) {
    if (format === 3) dv.setFloat32(p, s, true);
    else if (bits === 16) dv.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(s * 32768))), true);
    else if (bits === 8) dv.setUint8(p, Math.max(0, Math.min(255, Math.round((s + 1) * 128))));
    p += bytesPerSample;
  }
  return buf;
}

describe('resampleTo16k', () => {
  it('returns input unchanged when already 16k', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleTo16k(input, SAMPLE_RATE)).toBe(input);
  });

  it('halves the length for 32k input', () => {
    const input = new Float32Array(32); // 32k rate, 32 samples
    const out = resampleTo16k(input, 32000);
    expect(out.length).toBe(16);
  });
});

describe('chunkAudio', () => {
  it('returns a single chunk for short audio', () => {
    const pcm = new Float32Array(SAMPLE_RATE); // 1s
    const chunks = chunkAudio(pcm);
    expect(chunks.length).toBe(1);
  });

  it('chunks long audio with 2s overlap', () => {
    const pcm = new Float32Array(90 * SAMPLE_RATE); // 90s → 30s chunks, 2s overlap
    const chunks = chunkAudio(pcm);
    expect(chunks.length).toBe(4);
    expect(chunks[0].length).toBe(30 * SAMPLE_RATE);
    expect(chunks[1].length).toBe(30 * SAMPLE_RATE);
  });
});

describe('stitch', () => {
  it('removes duplicated overlap words', () => {
    const a = 'this is a test of the stitching mechanism';
    const b = 'stitching mechanism works well';
    const out = stitch(a, b);
    expect(out).toContain('this is a test of the stitching mechanism works well');
  });

  it('handles an empty first part', () => {
    expect(stitch('', 'hello there')).toBe('hello there');
  });
});

describe('stitchAll', () => {
  it('joins overlapping parts in order', () => {
    const parts = ['one two three four', 'three four five six', 'five six seven'];
    const out = stitchAll(parts);
    expect(out).toBe('one two three four five six seven');
  });
});

describe('decodeWavSamples', () => {
  it('recognizes the RIFF/WAVE signature', () => {
    expect(isWav(wavBytes({ samples: [0] }))).toBe(true);
    expect(isWav(new Uint8Array(12).buffer)).toBe(false);
  });

  it('decodes 16-bit PCM mono', () => {
    const bytes = wavBytes({ samples: [0.5, -0.25, 1, -1] });
    const r = decodeWavSamples(bytes);
    expect(r).not.toBeNull();
    expect(r!.sampleRate).toBe(16000);
    expect(r!.samples.length).toBe(4);
    expect(r!.samples[0]).toBeCloseTo(0.5, 3);
    expect(r!.samples[1]).toBeCloseTo(-0.25, 3);
    expect(r!.samples[2]).toBeCloseTo(1, 3);
    expect(r!.samples[3]).toBeCloseTo(-1, 3);
  });

  it('downmixes stereo to mono', () => {
    const bytes = wavBytes({ channels: 2, samples: [0.5, 0.1, 0.25, -0.25] });
    const r = decodeWavSamples(bytes);
    expect(r!.samples.length).toBe(2);
    expect(r!.samples[0]).toBeCloseTo(0.3, 3); // (0.5 + 0.1) / 2
    expect(r!.samples[1]).toBeCloseTo(0, 3); // (0.25 - 0.25) / 2
  });

  it('decodes 32-bit float WAV', () => {
    const bytes = wavBytes({ format: 3, bits: 32, samples: [0.25, 0.75] });
    const r = decodeWavSamples(bytes);
    expect(r!.samples[0]).toBeCloseTo(0.25, 3);
    expect(r!.samples[1]).toBeCloseTo(0.75, 3);
  });

  it('returns null for non-WAV bytes', () => {
    expect(decodeWavSamples(new Uint8Array([0, 1, 2, 3]).buffer)).toBeNull();
  });
});

describe('decodeToPcm16k', () => {
  it('decodes WAV without Web Audio and resamples to 16 kHz', async () => {
    const bytes = wavBytes({ rate: 32000, samples: [0.5, 0.5, 0.5, 0.5] });
    const pcm = await decodeToPcm16k(bytes);
    expect(pcm.length).toBe(2); // 4 samples @ 32k → 2 @ 16k
    expect(pcm[0]).toBeCloseTo(0.5, 3);
  });

  it('rejects non-WAV bytes when OfflineAudioContext is unavailable', async () => {
    const old = (globalThis as any).OfflineAudioContext;
    (globalThis as any).OfflineAudioContext = undefined;
    try {
      await expect(decodeToPcm16k(new Uint8Array([1, 2, 3]).buffer)).rejects.toThrow(/unavailable/);
    } finally {
      (globalThis as any).OfflineAudioContext = old;
    }
  });
});
