/**
 * Model catalog + CORS-enabled downloader backed by the Cache API so models
 * are fetched once and then work offline. Everything here is public model
 * weights, never user content.
 */

export const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';

const HF = 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main';

export const OCR_DET = {
  name: 'PP-OCRv3 mobile detection',
  url: `${HF}/detection/v3/det.onnx`,
  sizeBytes: 2_429_873,
};

export const OCR_REC: Record<'en' | 'hi' | 'ur', {
  name: string;
  url: string;
  dictUrl: string;
  /** Nominal on-disk size of the model file, in bytes (for preflight display). */
  sizeBytes: number;
}> = {
  en: {
    name: 'PP-OCRv5 English recognition',
    url: `${HF}/languages/english/rec.onnx`,
    dictUrl: `${HF}/languages/english/dict.txt`,
    sizeBytes: 7_830_888,
  },
  hi: {
    name: 'PP-OCRv3 Devanagari recognition',
    url: `${HF}/languages/hindi/rec.onnx`,
    dictUrl: `${HF}/languages/hindi/dict.txt`,
    sizeBytes: 8_980_224,
  },
  ur: {
    name: 'PP-OCRv3 Arabic/Urdu recognition',
    url: `${HF}/languages/arabic/rec.onnx`,
    dictUrl: `${HF}/languages/arabic/dict.txt`,
    sizeBytes: 8_978_664,
  },
};

export type AsrModelKey = 'whisper-tiny' | 'whisper-base' | 'moonshine-tiny' | 'moonshine-base';

/**
 * Parse a UI-selected ASR model key into its family + tier. Whisper is the
 * multilingual primary (spec §6); Moonshine is an opt-in English-only option.
 */
export function parseAsrModel(key: AsrModelKey): { family: 'moonshine' | 'whisper'; tier: 'tiny' | 'base' } {
  const i = key.lastIndexOf('-');
  return {
    family: key.slice(0, i) as 'moonshine' | 'whisper',
    tier: key.slice(i + 1) as 'tiny' | 'base',
  };
}

export const ASR_MODELS: Record<'moonshine' | 'whisper', { tiny: string; base: string }> = {
  moonshine: {
    tiny: 'onnx-community/moonshine-tiny-ONNX',
    base: 'onnx-community/moonshine-base-ONNX',
  },
  whisper: {
    tiny: 'onnx-community/whisper-tiny',
    base: 'onnx-community/whisper-base',
  },
};

/**
 * Nominal sizes for ASR models (decoder_merged + encoder, WASM int8), used
 * for preflight display. Keyed by the same model IDs as ASR_MODELS.
 */
export const ASR_SIZES: Record<string, number> = {
  'onnx-community/moonshine-tiny-ONNX': 28_127_173,
  'onnx-community/moonshine-base-ONNX': 62_916_062,
  'onnx-community/whisper-tiny': 40_886_921,
  'onnx-community/whisper-base': 76_894_612,
};

const MODEL_CACHE = 'converter-models-v1';

export interface ModelProgress {
  loaded: number;
  total: number;
  url: string;
}

async function fetchWithProgress(
  url: string,
  onProgress?: (p: ModelProgress) => void,
): Promise<Uint8Array> {
  const resp = await fetch(url, { mode: 'cors' });
  if (!resp.ok) {
    const e = new Error(`HTTP ${resp.status} downloading ${url}`);
    (e as Error & { code: string }).code = 'MODEL_DOWNLOAD';
    throw e;
  }
  if (!resp.body) return new Uint8Array(await resp.arrayBuffer());
  const total = Number(resp.headers.get('content-length')) || 0;
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ loaded, total, url });
  }
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * Fetch a model file, using the Cache API as a persistent offline cache.
 * Falls back to a plain fetch when the Cache API is unavailable (e.g. some
 * private-browsing modes), so the app degrades rather than failing.
 */
export async function fetchCachedModel(
  url: string,
  onProgress?: (p: ModelProgress) => void,
): Promise<Uint8Array> {
  try {
    const cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
    const bytes = await fetchWithProgress(url, onProgress);
    try {
      await cache.put(url, new Response(bytes.slice().buffer as ArrayBuffer));
    } catch {
      // cache write failed — proceed with in-memory bytes
    }
    return bytes;
  } catch (e) {
    if ((e as Error & { code?: string })?.code === 'MODEL_DOWNLOAD') throw e;
    // Cache API open/match failed (private mode) → plain fetch.
    return fetchWithProgress(url, onProgress);
  }
}
