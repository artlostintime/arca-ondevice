/**
 * Conversion orchestration. The single entry point the UI calls:
 *
 *   convertFile(bytes, fileName, options) → ConversionResult
 *
 * Routes by real content (detectFile), spawns the right worker, and for
 * scanned/mixed PDFs OCRs the pages pdf-inspector flagged and merges the
 * text back in page order. Everything on the main thread here is cheap; all
 * heavy work happens inside Web Workers.
 */
import { detectFile } from './filetype';
import { decodeText, mergePdfText } from './doc-text';
import { effectiveKey, langDef, type LangKey } from './langs';
import { renderPdfPage, releasePdf } from './pdf-render';
import { ConversionResult, formatBytes, toDetected } from './result';
import { createWorker, WorkerCallError, WorkerManager } from './worker-manager';
import type { AsrModelKey } from './models';
import type {
  DocAnalyzeResult,
  OcrImageResult,
} from '../workers/comms';

const manager = new WorkerManager(createWorker);

/** Default cap for a single input file (spec §10 — huge files). */
const DEFAULT_MAX_FILE_SIZE = 512 * 1024 * 1024;

export interface ConvertOptions {
  /** UI-selected language; 'auto' → English. Used as the Whisper hint + OCR language. */
  lang?: LangKey;
  /** ASR model (spec §6): Whisper Tiny multilingual by default; Moonshine is an English-only opt-in. */
  asrModel?: AsrModelKey;
  /** ASR device. Default 'auto' (WebGPU→WebNN→WASM inside transformers.js). */
  asrDevice?: 'auto' | 'wasm';
  /** Reject files larger than this many bytes (default 512 MB). */
  maxFileSize?: number;
  onProgress?: (p: ConvertProgress) => void;
}

export interface ConvertProgress {
  phase: 'reading' | 'analyzing' | 'model' | 'ocr' | 'asr' | 'done';
  percent: number; // 0..100
  detail?: string;
}

export function fail(fileName: string, code: string, message: string): ConversionResult {
  return {
    id: crypto.randomUUID(),
    fileName,
    detected: { category: 'unknown', format: 'unknown', confidence: 0, label: '—' },
    markdown: '',
    metadata: { engine: '', fallbacksUsed: [], durationMs: 0, sizeBytes: 0 },
    warnings: [message],
    createdAt: Date.now(),
    status: 'error',
    error: { code, message },
  };
}

function mimeForFormat(format: string): string {
  const map: Record<string, string> = {
    wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
    aiff: 'audio/aiff', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm',
  };
  return map[format] ?? '';
}

/** Surface model downloads as a distinct UI phase so the preflight panel shows. */
function uiPhase(wp: string, fallback: ConvertProgress['phase']): ConvertProgress['phase'] {
  return wp === 'downloading-model' || wp === 'loading-model' ? 'model' : fallback;
}

export async function convertFile(
  bytes: Uint8Array,
  fileName: string,
  opts: ConvertOptions = {},
): Promise<ConversionResult> {
  const id = crypto.randomUUID();
  const started = Date.now();
  const warnings: string[] = [];
  const fallbacks: string[] = [];
  const onProgress = opts.onProgress;
  const lang = effectiveKey(opts.lang ?? 'auto');
  const ocrLang = langDef(lang).ocrKey;

  const p = (phase: ConvertProgress['phase'], percent: number, detail?: string) =>
    onProgress?.({ phase, percent, detail });

  try {
    const maxSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    if (bytes.byteLength > maxSize) {
      return fail(
        fileName,
        'too-large',
        `This file is ${formatBytes(bytes.byteLength)} — the limit is ${formatBytes(maxSize)}. Split it into smaller files or reduce the resolution.`,
      );
    }

    const info = detectFile(bytes, fileName);
    p('reading', 10, info.label);

    if (info.category === 'unsupported' || info.category === 'unknown') {
      return fail(fileName, info.format, info.reason ?? `Unsupported file type (${info.label}).`);
    }

    // Plain text — decode directly, no worker needed.
    if (info.category === 'text') {
      const md = '```text\n' + decodeText(bytes) + '\n```';
      return {
        id, fileName,
        detected: toDetected(info),
        markdown: md,
        metadata: {
          engine: 'text', fallbacksUsed: [], durationMs: Date.now() - started,
          sizeBytes: bytes.byteLength,
        },
        warnings, createdAt: Date.now(), status: 'ok',
      };
    }

    // Documents (PDF/office/csv/epub/rtf)
    if (info.category === 'document') {
      const result = await manager.call<DocAnalyzeResult>('doc', {
        id, type: 'analyze', sessionId: id, bytes, format: info.format, name: fileName,
      }, { onProgress: (ev) => p('analyzing', 20 + (ev.percent ?? 0) * 0.2, ev.detail) });

      const isPdf = info.format === 'pdf' || result.kind === 'pdf';
      if (isPdf) {
        const needOcr = result.pagesNeedingOcr ?? [];
        const ocrByPage = new Map<number, string>();
        try {
          if (needOcr.length) {
            p('ocr', 40, `OCR-ing ${needOcr.length} scanned page${needOcr.length > 1 ? 's' : ''}…`);
            for (const page of needOcr) {
              const pixels = await renderPdfPage(id, bytes, page, 2200);
              const ocr = await manager.call<OcrImageResult>('ocr', {
                id: `${id}-o${page}`, type: 'ocr-image', imageData: pixels, language: ocrLang,
              }, { onProgress: (ev) => p('ocr', 40 + (ev.percent ?? 0) * 0.4, ev.detail) });
              ocrByPage.set(page, ocr.text);
              if (ocr.engine === 'tesseract') fallbacks.push('OCR: Tesseract');
            }
          }
        } finally {
          await releasePdf(id);
        }
        const markdown = mergePdfText(result.markdown, result.pageCount ?? needOcr.length, ocrByPage);
        return {
          id, fileName,
          detected: toDetected(info),
          markdown,
          metadata: {
            engine: 'pdf-inspector' + (needOcr.length ? '+ocr' : ''),
            fallbacksUsed: fallbacks,
            durationMs: Date.now() - started,
            sizeBytes: bytes.byteLength,
          },
          warnings, createdAt: Date.now(), status: 'ok',
        };
      }

      return {
        id, fileName, detected: toDetected(info), markdown: result.markdown,
        metadata: {
          engine: 'anydoc', fallbacksUsed: fallbacks, durationMs: Date.now() - started,
          sizeBytes: bytes.byteLength,
        },
        warnings, createdAt: Date.now(), status: 'ok',
      };
    }

    // Images → OCR directly.
    if (info.category === 'image') {
      if (info.reason) warnings.push(info.reason);
      p('ocr', 30, 'Recognizing text…');
      const ocr = await manager.call<OcrImageResult>('ocr', {
        id, type: 'ocr-image', bytes, mime: `image/${info.format === 'jpeg' ? 'jpeg' : info.format}`,
        language: ocrLang,
      }, { onProgress: (ev) => p(uiPhase(ev.phase, 'ocr'), 30 + (ev.percent ?? 0) * 0.6, ev.detail) });
      if (ocr.engine === 'tesseract') fallbacks.push('OCR: Tesseract');
      if (!ocr.text.trim()) warnings.push('No text was detected in this image.');
      return {
        id, fileName, detected: toDetected(info), markdown: ocr.text || '_No text detected._',
        metadata: {
          engine: 'rapidocr', fallbacksUsed: fallbacks, durationMs: Date.now() - started,
          sizeBytes: bytes.byteLength,
          ocr: { meanConfidence: ocr.meanConfidence },
        },
        warnings, createdAt: Date.now(), status: 'ok',
      };
    }

    // Audio/video → ASR (decode + chunk inside the worker).
    if (info.category === 'audio' || info.category === 'video') {
      p('asr', 30, 'Loading model…');
      const model = opts.asrModel ?? 'whisper-tiny';
      const device = opts.asrDevice ?? 'auto';
      const result = await manager.call<{ text: string; model: string; language: string; durationSec: number; chunks: number }>('asr', {
        id, type: 'transcribe', bytes: bytes.slice().buffer,
        mime: mimeForFormat(info.format), language: lang, model, device,
      }, { onProgress: (ev) => p(uiPhase(ev.phase, 'asr'), 30 + (ev.percent ?? 0) * 0.6, ev.detail) });
      if (!result.text.trim()) warnings.push('No speech was detected in this audio.');
      return {
        id, fileName, detected: toDetected(info), markdown: result.text || '_No speech detected._',
        metadata: {
          engine: result.model, fallbacksUsed: fallbacks, durationMs: Date.now() - started,
          sizeBytes: bytes.byteLength,
        },
        warnings, createdAt: Date.now(), status: 'ok',
      };
    }

    return fail(fileName, 'unhandled', `Unhandled category: ${info.category}.`);
  } catch (e) {
    if (e instanceof WorkerCallError) {
      return {
        id, fileName,
        detected: { category: 'unknown', format: 'unknown', confidence: 0, label: '—' },
        markdown: '', warnings, createdAt: Date.now(), status: 'error',
        metadata: { engine: '', fallbacksUsed: fallbacks, durationMs: Date.now() - started, sizeBytes: bytes.byteLength },
        error: { code: e.code, message: e.message },
      };
    }
    const msg = (e as Error)?.message ?? String(e);
    return {
      id, fileName,
      detected: { category: 'unknown', format: 'unknown', confidence: 0, label: '—' },
      markdown: '', warnings, createdAt: Date.now(), status: 'error',
      metadata: { engine: '', fallbacksUsed: fallbacks, durationMs: Date.now() - started, sizeBytes: bytes.byteLength },
      error: { code: 'internal', message: msg },
    };
  }
}

/** Cleanup: terminate all workers (e.g. on page unload / worker reuse). */
export function disposeWorkers(): void {
  manager.terminateAll();
}
