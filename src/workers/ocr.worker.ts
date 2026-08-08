/// <reference lib="webworker" />
/**
 * OCR worker. PP-OCR (RapidOCR) detection + recognition via onnxruntime-web,
 * with a Tesseract.js fallback when the WebAssembly/ORT path is unavailable.
 *
 * Models (smallest viable, downloaded once + cached):
 *   det  PP-OCRv3 mobile detection  (~2.4 MB)
 *   rec  en (PP-OCRv5) / hi (Devanagari v3) / ur (Arabic v3)  (~8 MB each)
 */
import * as ort from 'onnxruntime-web';
import { fetchCachedModel, OCR_DET, OCR_REC, ORT_CDN, type ModelProgress } from '../lib/models';
import { binarize, contrastStretch, estimateSkew, median3, otsuThreshold, rotateGray, toGray } from '../lib/preprocess';
import type { OcrImageRequest, WorkerError, WorkerProgress } from './comms';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const REC_MEAN = [0.5, 0.5, 0.5];
const REC_STD = [0.5, 0.5, 0.5];

/**
 * Accuracy strategy (spec §7): small model first, quality check, then fall
 * back to a stronger path. Below this mean line-confidence the PP-OCR result
 * is deemed untrustworthy and Tesseract retries the page.
 */
const OCR_QUALITY_THRESHOLD = 0.5;

let ortReady = false;
let detSession: ort.InferenceSession | null = null;
const recSessions = new Map<string, ort.InferenceSession>();
const dicts = new Map<string, string[]>();
let tesseractWorkers: Map<string, any> | null = null;

function post(data: WorkerProgress | WorkerError): void {
  ctx.postMessage(data);
}

function progress(id: string, phase: string, detail?: string, percent?: number, index?: number, total?: number): void {
  post({ id, type: 'progress', phase, detail, percent, index, total });
}

function modelProgress(id: string, name: string, p: ModelProgress): void {
  const percent = p.total ? Math.round((p.loaded / p.total) * 100) : undefined;
  progress(id, 'downloading-model', `${name}: ${Math.round(p.loaded / 1_048_576)} MB`, percent);
}

async function ensureOrt(): Promise<void> {
  if (ortReady) return;
  ort.env.wasm.wasmPaths = ORT_CDN;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ortReady = true;
}

async function ensureDet(id: string): Promise<void> {
  if (detSession) return;
  progress(id, 'loading-model', OCR_DET.name);
  const bytes = await fetchCachedModel(OCR_DET.url, (p) => modelProgress(id, OCR_DET.name, p));
  detSession = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
}

async function ensureRec(id: string, lang: 'en' | 'hi' | 'ur'): Promise<void> {
  if (recSessions.has(lang) && dicts.has(lang)) return;
  const cfg = OCR_REC[lang];
  progress(id, 'loading-model', cfg.name);
  const [modelBytes, dictBytes] = await Promise.all([
    fetchCachedModel(cfg.url, (p) => modelProgress(id, cfg.name, p)),
    fetchCachedModel(cfg.dictUrl),
  ]);
  const dict = new TextDecoder('utf-8')
    .decode(dictBytes)
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
  dicts.set(lang, dict);
  recSessions.set(lang, session);
}

// --- image source ---

async function toImageData(req: OcrImageRequest): Promise<ImageData> {
  if (req.imageData) return req.imageData;
  if (!req.bytes) throw new Error('no image input');
  const mime = req.mime ?? 'image/png';
  let blob = new Blob([req.bytes as BlobPart], { type: mime });
  if (mime === 'image/heic' || mime === 'image/heif' || mime === 'image/avif') {
    try {
      // Chromium/Firefox can't decode HEIC; transcode to PNG via libheif-wasm.
      const { default: heic2any } = await import('heic2any');
      const out = await heic2any({ blob, toType: 'image/png', quality: 0.9 });
      blob = out instanceof Blob ? out : out[0];
    } catch {
      // Safari decodes natively — fall through to createImageBitmap.
    }
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx2d) throw new Error('2D canvas unavailable');
  ctx2d.drawImage(bitmap, 0, 0);
  const data = ctx2d.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return data;
}

// --- preprocessing ---

function detDims(sw: number, sh: number): { w: number; h: number } {
  const maxSide = 960;
  const r = Math.min(1, maxSide / Math.max(sw, sh));
  let w = Math.max(16, Math.round(sw * r));
  let h = Math.max(16, Math.round(sh * r));
  w = Math.ceil(w / 32) * 32;
  h = Math.ceil(h / 32) * 32;
  return { w, h };
}

/** Bilinear-resize RGBA → [h, w, 3] float 0..1. */
function rgbaToHwc(imageData: ImageData, targetW: number, targetH: number): Float32Array {
  const src = imageData.data;
  const sw = imageData.width;
  const sh = imageData.height;
  const out = new Float32Array(targetH * targetW * 3);
  for (let y = 0; y < targetH; y++) {
    const sy = ((y + 0.5) * sh) / targetH - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < targetW; x++) {
      const sx = ((x + 0.5) * sw) / targetW - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fy) * (1 - fx);
      const w01 = (1 - fy) * fx;
      const w10 = fy * (1 - fx);
      const w11 = fy * fx;
      const di = (y * targetW + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[di + c] = (src[i00 + c] * w00 + src[i01 + c] * w01 + src[i10 + c] * w10 + src[i11 + c] * w11) / 255;
      }
    }
  }
  return out;
}

function hwcToChwNormalized(rgb: Float32Array, w: number, h: number, mean: number[], std: number[]): Float32Array {
  const out = new Float32Array(3 * h * w);
  const len = h * w;
  for (let c = 0; c < 3; c++) {
    const inv = 1 / std[c];
    for (let i = 0; i < len; i++) {
      out[c * len + i] = (rgb[i * 3 + c] - mean[c]) * inv;
    }
  }
  return out;
}

/** Connected components on the binarized probability map → tight boxes in prob-map space. */
function findBoxes(prob: Float32Array, pw: number, ph: number): number[][] {
  const thresh = 0.3;
  const bin = new Uint8Array(ph * pw);
  for (let i = 0; i < bin.length; i++) bin[i] = prob[i] > thresh ? 1 : 0;
  const visited = new Uint8Array(ph * pw);
  const boxes: number[][] = [];
  const stack: number[] = [];
  const dirs = [-1, 1, -pw, pw, -pw - 1, -pw + 1, pw - 1, pw + 1];
  for (let i = 0; i < bin.length; i++) {
    if (!bin[i] || visited[i]) continue;
    stack.push(i);
    visited[i] = 1;
    let minX = pw, minY = ph, maxX = -1, maxY = -1;
    while (stack.length) {
      const cur = stack.pop()!;
      const x = cur % pw;
      const y = (cur / pw) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const d of dirs) {
        const ni = cur + d;
        if (ni < 0 || ni >= bin.length) continue;
        const nx = ni % pw;
        const ny = (ni / pw) | 0;
        if (Math.abs(ny - y) > 1 || Math.abs(nx - x) > 1) continue;
        if (bin[ni] && !visited[ni]) {
          visited[ni] = 1;
          stack.push(ni);
        }
      }
    }
    if (maxX - minX < 1 && maxY - minY < 1) continue;
    boxes.push([minX, minY, maxX + 1, maxY + 1]);
  }
  return boxes;
}

function cropRegion(img: ImageData, x: number, y: number, w: number, h: number): ImageData {
  const out = new ImageData(w, h);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const si = ((y + yy) * img.width + (x + xx)) * 4;
      const di = (yy * w + xx) * 4;
      for (let c = 0; c < 4; c++) out.data[di + c] = img.data[si + c];
    }
  }
  return out;
}

function splitWideCrop(img: ImageData, maxW: number): ImageData[] {
  if (img.width <= maxW) return [img];
  const ink = new Uint8Array(img.width);
  const data = img.data;
  for (let x = 0; x < img.width; x++) {
    let min = 255;
    for (let y = 0; y < img.height; y++) {
      const i = (y * img.width + x) * 4;
      const v = Math.min(data[i], data[i + 1], data[i + 2]);
      if (v < min) min = v;
    }
    ink[x] = min;
  }
  const blobs: { x0: number; x1: number }[] = [];
  let x = 0;
  while (x < img.width) {
    while (x < img.width && ink[x] > 200) x++;
    if (x >= img.width) break;
    let x1 = x;
    while (x1 < img.width && ink[x1] <= 200) x1++;
    blobs.push({ x0: x, x1 });
    x = x1;
  }
  if (!blobs.length) return [img];
  const gaps: number[] = [];
  for (let i = 1; i < blobs.length; i++) gaps.push(blobs[i].x0 - blobs[i - 1].x1);
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const gapThresh = Math.max(8, median * 2.5);
  const words: { x0: number; x1: number }[] = [];
  let cur = { ...blobs[0] };
  for (let i = 1; i < blobs.length; i++) {
    const g = blobs[i].x0 - blobs[i - 1].x1;
    if (g > gapThresh) {
      words.push(cur);
      cur = { ...blobs[i] };
    } else {
      cur.x1 = blobs[i].x1;
    }
  }
  words.push(cur);
  const parts: ImageData[] = [];
  let pack: { x0: number; x1: number }[] = [];
  let w = 0;
  for (const wd of words) {
    const wdW = wd.x1 - wd.x0;
    if (pack.length && w + wdW > maxW) {
      parts.push(cropRegion(img, pack[0].x0, 0, pack[pack.length - 1].x1 - pack[0].x0, img.height));
      pack = [];
      w = 0;
    }
    pack.push(wd);
    w += wdW;
  }
  if (pack.length) parts.push(cropRegion(img, pack[0].x0, 0, pack[pack.length - 1].x1 - pack[0].x0, img.height));
  return parts;
}

function preprocessRec(img: ImageData): { tensor: Float32Array; w: number } {
  const targetH = 48;
  let tw = Math.round((targetH * img.width) / img.height);
  tw = Math.max(8, Math.min(480, tw));
  tw = Math.ceil(tw / 8) * 8;
  const rgb = rgbaToHwc(img, tw, targetH);
  const tensor = hwcToChwNormalized(rgb, tw, targetH, REC_MEAN, REC_STD);
  return { tensor, w: tw };
}

function ctcDecode(logits: Float32Array, dims: number[], dict: string[]): { text: string; conf: number } {
  const T = dims.length >= 2 ? dims[dims.length - 2] : 0;
  const C = dims.length >= 3 ? dims[dims.length - 1] : 0;
  if (!T || !C) return { text: '', conf: 0 };
  let s = '';
  let confSum = 0;
  let confN = 0;
  let prev = -1;
  for (let t = 0; t < T; t++) {
    const base = t * C;
    let best = -Infinity;
    let bi = 0;
    let denom = 0;
    for (let c = 0; c < C; c++) {
      const v = logits[base + c];
      denom += Math.exp(v);
      if (v > best) {
        best = v;
        bi = c;
      }
    }
    const p = denom > 0 ? Math.exp(best) / denom : 0;
    if (bi !== 0 && bi !== prev) {
      const ch = dict[bi - 1] ?? '';
      if (ch) {
        s += ch;
        confSum += p;
        confN++;
      }
    }
    prev = bi;
  }
  return { text: s, conf: confN ? confSum / confN : 0 };
}

// --- image preprocessing (improves OCR on bad scans) ---

/**
 * Pure numeric helpers (grayscale, Otsu, binarize, ink box, median, deskew,
 * rotation, contrast) live in lib/preprocess.ts so they're unit-testable.
 * This function orchestrates them and packs the result back into ImageData.
 *
 * Preprocessing runs on the FULL image (same size as the input): the text
 * detector is trained on page-like images, so feeding it a tight ink-box
 * crop degrades detection. Contrast/deskew/denoise still apply page-wide.
 */
function preprocess(imageData: ImageData): ImageData {
  const w = imageData.width, h = imageData.height;
  if (w < 8 || h < 8) return imageData;
  const gray = toGray(imageData.data, w, h);
  const stretched = contrastStretch(gray);

  const thresh = otsuThreshold(stretched, w, h);
  const bin = binarize(stretched, w, h, thresh);
  let rotated = stretched;
  if (bin.some((v) => v === 1)) {
    const angle = estimateSkew(bin, w, h);
    if (angle !== 0) rotated = rotateGray(stretched, w, h, (angle * Math.PI) / 180);
  }

  const denoised = median3(rotated, w, h);

  // Pack back into an ImageData (grayscale replicated to RGB).
  const out = new ImageData(w, h);
  for (let i = 0, j = 0; i < denoised.length; i++, j += 4) {
    out.data[j] = denoised[i];
    out.data[j + 1] = denoised[i];
    out.data[j + 2] = denoised[i];
    out.data[j + 3] = 255;
  }
  return out;
}

// --- main pipeline ---

async function recognizePP(id: string, imageData: ImageData, lang: 'en' | 'hi' | 'ur') {  await ensureOrt();
  await ensureDet(id);
  await ensureRec(id, lang);
  const sw = imageData.width;
  const sh = imageData.height;
  const det = detSession!;
  const rec = recSessions.get(lang)!;
  const dict = dicts.get(lang)!;

  progress(id, 'detecting', 'Locating text regions…');
  const { w: dW, h: dH } = detDims(sw, sh);
  const rgb = rgbaToHwc(imageData, dW, dH);
  const tensor = hwcToChwNormalized(rgb, dW, dH, DET_MEAN, DET_STD);
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, dH, dW]) });
  const prob = out[det.outputNames[0]] as ort.Tensor;
  const probData = prob.data as Float32Array;
  const pw = prob.dims[prob.dims.length - 1];
  const ph = prob.dims[prob.dims.length - 2];

  const boxes = findBoxes(probData, pw, ph);
  const scaleX = sw / pw;
  const scaleY = sh / ph;
  const orig = boxes
    .map((b) => [
      Math.max(0, Math.min(sw, Math.round(b[0] * scaleX))),
      Math.max(0, Math.min(sh, Math.round(b[1] * scaleY))),
      Math.max(0, Math.min(sw, Math.round(b[2] * scaleX))),
      Math.max(0, Math.min(sh, Math.round(b[3] * scaleY))),
    ])
    .map((b) => {
      const w = b[2] - b[0], h = b[3] - b[1];
      const offset = Math.round((w * h) / (2 * (w + h)) * 1.5);
      const ex = Math.max(offset, Math.round(w * 0.1));
      const ey = Math.max(offset, Math.round(h * 0.4));
      return [
        Math.max(0, b[0] - ex),
        Math.max(0, b[1] - ey),
        Math.min(sw, b[2] + ex),
        Math.min(sh, b[3] + ey),
      ];
    })
    .filter((b) => b[2] - b[0] >= 3 && b[3] - b[1] >= 3)
    .sort((a, b) => {
      const dy = a[1] - b[1];
      return dy !== 0 ? dy : a[0] - b[0];
    });

  progress(id, 'recognizing', `Recognizing ${orig.length} lines…`);
  const lines: { text: string; confidence: number }[] = [];
  for (let i = 0; i < orig.length; i++) {
    const crop = cropRegion(imageData, orig[i][0], orig[i][1], orig[i][2] - orig[i][0], orig[i][3] - orig[i][1]);
    const parts = splitWideCrop(crop, 480);
    let text = '';
    let conf = 0;
    let n = 0;
    for (const part of parts) {
      const { tensor: rt, w } = preprocessRec(part);
      const rOut = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', rt, [1, 3, 48, w]) });
      const rLogits = rOut[rec.outputNames[0]] as ort.Tensor;
      const dec = ctcDecode(rLogits.data as Float32Array, rLogits.dims as number[], dict);
      if (dec.text) {
        text += (text ? ' ' : '') + dec.text;
        conf += dec.conf;
        n++;
      }
    }
    if (text) lines.push({ text, confidence: n ? conf / n : 0 });
    if ((i + 1) % 5 === 0 || i === orig.length - 1) {
      progress(id, 'recognizing', `Recognized ${i + 1}/${orig.length} lines`, undefined, i + 1, orig.length);
    }
  }

  const fullText = lines.map((l) => l.text).join('\n');
  const mean = lines.length ? lines.reduce((a, l) => a + l.confidence, 0) / lines.length : 0;
  return {
    id,
    type: 'ocr-result',
    text: fullText,
    lines,
    meanConfidence: mean,
    engine: 'ppocr',
    language: lang,
  };
}

// --- Tesseract fallback ---

async function getTesseractWorker(lang: 'en' | 'hi' | 'ur') {
  if (!tesseractWorkers) tesseractWorkers = new Map();
  if (tesseractWorkers.has(lang)) return tesseractWorkers.get(lang);
  const { createWorker } = await import('tesseract.js');
  const map = { en: 'eng', hi: 'hin', ur: 'urd' } as const;
  const worker = await createWorker(map[lang], 1, {
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7/tesseract-core-simd.wasm.js',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') progress('tesseract', 'recognizing', `${Math.round(m.progress * 100)}%`);
    },
  });
  tesseractWorkers.set(lang, worker);
  return worker;
}

async function recognizeTesseract(id: string, source: ImageData | Uint8Array, lang: 'en' | 'hi' | 'ur') {
  const worker = await getTesseractWorker(lang);
  let image: Blob;
  if (source instanceof ImageData) {
    const canvas = new OffscreenCanvas(source.width, source.height);
    const c = canvas.getContext('2d')!;
    c.putImageData(source, 0, 0);
    image = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    image = new Blob([source as BlobPart], { type: 'image/png' });
  }
  const { data } = await worker.recognize(image);
  const lines = (data.lines ?? []).map((l: { text: string; confidence: number }) => ({
    text: l.text,
    confidence: l.confidence,
  }));
  return {
    id,
    type: 'ocr-result',
    text: data.text,
    lines,
    meanConfidence: typeof data.confidence === 'number' ? data.confidence : 0,
    engine: 'tesseract',
    language: lang,
  };
}

ctx.onmessage = async (ev: MessageEvent<OcrImageRequest>) => {
  const req = ev.data;
  try {
    const raw = await toImageData(req);
    // Preprocess once; if it throws (e.g. OffscreenCanvas limits), fall back
    // to the raw image rather than failing the whole job.
    let imageData: ImageData;
    try {
      progress(req.id, 'preprocessing', 'Deskewing and denoising…');
      imageData = preprocess(raw);
    } catch {
      imageData = raw;
    }
    let result;
    try {
      result = await recognizePP(req.id, imageData, req.language);
      const weak = result.lines.length === 0 || result.meanConfidence < OCR_QUALITY_THRESHOLD;
      if (weak) {
        progress(req.id, 'fallback', `Low OCR confidence — switching to Tesseract…`);
        result = await recognizeTesseract(req.id, imageData, req.language);
      }
    } catch (e) {
      progress(req.id, 'fallback', 'Switching to Tesseract fallback…');
      result = await recognizeTesseract(req.id, imageData, req.language);
    }
    ctx.postMessage(result);
  } catch (e) {
    ctx.postMessage({
      id: req.id,
      type: 'error',
      code: (e as { code?: string })?.code ?? 'internal',
      message: (e as Error)?.message ?? String(e),
    } as WorkerError);
  }
};
