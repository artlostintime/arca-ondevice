/**
 * Pure audio helpers: decode → 16 kHz mono PCM, chunking with overlap, and
 * overlap-aware stitching. The decode step is browser-only (OfflineAudioContext);
 * the rest is pure and unit-testable.
 */

export const SAMPLE_RATE = 16_000;
export const CHUNK_SECONDS = 30;
export const OVERLAP_SECONDS = 2;

/** Resample a Float32Array (any rate) to 16 kHz mono via linear interpolation. */
export function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === SAMPLE_RATE) return input;
  const ratio = fromRate / SAMPLE_RATE;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** Split 16 kHz PCM into 30s chunks with 2s overlap. */
export function chunkAudio(pcm: Float32Array): Float32Array[] {
  const chunkLen = CHUNK_SECONDS * SAMPLE_RATE;
  const overlap = OVERLAP_SECONDS * SAMPLE_RATE;
  const step = chunkLen - overlap;
  if (pcm.length <= chunkLen) return [pcm];
  const chunks: Float32Array[] = [];
  let start = 0;
  while (start < pcm.length) {
    const end = Math.min(pcm.length, start + chunkLen);
    chunks.push(pcm.slice(start, end));
    if (end >= pcm.length) break;
    start += step;
  }
  return chunks;
}

function words(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

/**
 * Join two chunk transcripts, removing duplicated overlap text at the
 * boundary by matching the longest common word-level suffix/prefix.
 */
export function stitch(a: string, b: string): string {
  const aw = words(a);
  const bw = words(b);
  if (!aw.length) return b.trim();
  if (!bw.length) return a.trim();
  const maxK = Math.min(aw.length, bw.length, 12);
  let keep = 0;
  for (let k = maxK; k >= 2; k--) {
    const suf = aw.slice(aw.length - k).join(' ').toLowerCase();
    const pre = bw.slice(0, k).join(' ').toLowerCase();
    if (suf === pre) {
      keep = k;
      break;
    }
  }
  return aw.join(' ') + ' ' + bw.slice(keep).join(' ');
}

export function stitchAll(parts: string[]): string {
  return parts.reduce((acc, p) => (acc ? stitch(acc, p) : p), '');
}

/**
 * Detect a RIFF/WAVE container from raw bytes.
 */
export function isWav(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 12) return false;
  const v = new Uint8Array(bytes, 0, 12);
  return (
    v[0] === 0x52 && v[1] === 0x49 && v[2] === 0x46 && v[3] === 0x46 && // 'RIFF'
    v[8] === 0x57 && v[9] === 0x41 && v[10] === 0x56 && v[11] === 0x45 // 'WAVE'
  );
}

/**
 * Parse an uncompressed WAV (PCM/float) into mono float samples.
 * Returns null for anything that isn't a directly-decodable RIFF/WAVE
 * (e.g. compressed formats), so callers can fall back to Web Audio.
 */
export function decodeWavSamples(bytes: ArrayBuffer): { samples: Float32Array; sampleRate: number } | null {
  if (!isWav(bytes)) return null;
  const dv = new DataView(bytes);
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: { offset: number; length: number } | null = null;
  let offset = 12;
  while (offset + 8 <= dv.byteLength) {
    const id = dv.getUint32(offset, true);
    const size = dv.getUint32(offset + 4, true);
    if (id === 0x20746d66) {
      // 'fmt '
      let format = dv.getUint16(offset + 8, true);
      const channels = dv.getUint16(offset + 10, true);
      const rate = dv.getUint32(offset + 12, true);
      const bits = dv.getUint16(offset + 22, true);
      if (format === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE: sub-format GUID first 2 bytes hold the real format
        format = dv.getUint16(offset + 32, true);
      }
      fmt = { format, channels, rate, bits };
    } else if (id === 0x61746164) {
      // 'data'
      data = { offset: offset + 8, length: size };
    }
    offset += 8 + size + (size % 2); // chunks are 16-bit aligned
  }
  if (!fmt || !data || !fmt.channels || !fmt.rate) return null;

  const { format, channels, rate, bits } = fmt;
  if (format !== 1 && format !== 3) return null; // compressed WAV → Web Audio fallback
  const bytesPerSample = bits / 8;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(data.length / frameBytes);
  const out = new Float32Array(frames);
  const byteOffset = data.offset;

  const readSample = (i: number): number => {
    switch (format) {
      case 1: // PCM
        if (bits === 8) return (dv.getUint8(byteOffset + i) - 128) / 128;
        if (bits === 16) return dv.getInt16(byteOffset + i, true) / 32768;
        if (bits === 24) {
          const b0 = dv.getUint8(byteOffset + i);
          const b1 = dv.getUint8(byteOffset + i + 1);
          const b2 = dv.getUint8(byteOffset + i + 2);
          let v = (b2 << 16) | (b1 << 8) | b0;
          if (v & 0x800000) v -= 0x1000000;
          return v / 8388608;
        }
        if (bits === 32) return dv.getInt32(byteOffset + i, true) / 2147483648;
        return 0;
      case 3: // IEEE float
        return dv.getFloat32(byteOffset + i, true);
      default:
        return 0;
    }
  };

  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += readSample(f * frameBytes + c * bytesPerSample);
    }
    out[f] = sum / channels;
  }
  return { samples: out, sampleRate: rate };
}

/**
 * Decode encoded audio/video bytes to 16 kHz mono PCM. WAV files are parsed
 * directly (no Web Audio required); everything else is decoded via the Web
 * Audio API. Browser-only; returns null where unavailable. Throws for
 * undecodable content (e.g. an unsupported container).
 */
export async function decodeToPcm16k(bytes: ArrayBuffer): Promise<Float32Array> {
  const wav = decodeWavSamples(bytes);
  if (wav) return resampleTo16k(wav.samples, wav.sampleRate);
  const Ctor = globalThis.OfflineAudioContext;
  if (!Ctor) throw new Error('Web Audio API (OfflineAudioContext) is unavailable in this browser.');
  const ctx = new Ctor(1, 1, 44100);
  const decoded = await ctx.decodeAudioData(bytes.slice(0));
  if (!decoded) throw new Error('decodeAudioData returned no audio buffer.');
  return resampleTo16k(decoded.getChannelData(0), decoded.sampleRate);
}
