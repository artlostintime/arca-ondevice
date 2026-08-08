/**
 * Model catalog + CORS-enabled downloader backed by the Cache API so models
 * are fetched once and then work offline. Everything here is public model
 * weights, never user content.
 */

export const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';

const HF = 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main';

export interface OcrRecModel {
  name: string;
  url: string;
  dictUrl: string;
  /** Nominal on-disk size of the model file, in bytes (for preflight display). */
  sizeBytes: number;
}

export const OCR_DET = {
  name: 'PP-OCRv3 mobile detection',
  url: `${HF}/detection/v3/det.onnx`,
  sizeBytes: 2_429_873,
};

export const OCR_REC: Record<'en' | 'hi' | 'ur', OcrRecModel> = {
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

export interface AsrModelId {
  tiny: string;
  base: string;
}

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

export const ASR_MODELS: Record<'moonshine' | 'whisper', AsrModelId> = {
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

export class ModelDownloadError extends Error {
  code = 'MODEL_DOWNLOAD';
  constructor(message: string) {
    super(message);
    this.name = 'ModelDownloadError';
  }
}

export interface ModelProgress {
  loaded: number;
  total: number;
  url: string;
}

async function fetchWithProgress(
  url: string,
  onProgress?: (p: ModelProgress) => void,
): Promise<Response> {
  const resp = await fetch(url, { mode: 'cors' });
  if (!resp.ok) throw new ModelDownloadError(`HTTP ${resp.status} downloading ${url}`);
  if (!resp.body) return resp;
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
  return new Response(new Blob(chunks as unknown as BlobPart[]), { status: 200, headers: { 'content-type': resp.headers.get('content-type') ?? 'application/octet-stream' } });
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
    const resp = await fetchWithProgress(url, onProgress);
    const buf = await resp.arrayBuffer();
    try {
      await cache.put(url, new Response(buf.slice(0)));
    } catch {
      // cache write failed — proceed with in-memory bytes
    }
    return new Uint8Array(buf);
  } catch (e) {
    if (e instanceof ModelDownloadError) throw e;
    // Cache API open/match failed (private mode) → plain fetch.
    const resp = await fetchWithProgress(url, onProgress);
    return new Uint8Array(await resp.arrayBuffer());
  }
}
