import type { LangKey } from '../lib/langs';
import type { AsrModelKey } from '../lib/models';

export type WorkerCategory = 'doc' | 'ocr' | 'asr';

export type WorkerRequest =
  | DocAnalyzeRequest
  | OcrImageRequest
  | AsrTranscribeRequest;

export interface DocAnalyzeRequest {
  id: string;
  type: 'analyze';
  sessionId: string;
  /** Uint8Array over the file bytes (cloned, not transferred). */
  bytes: Uint8Array;
  /** Format from the router, e.g. 'pdf', 'docx'. */
  format: string;
  name: string;
}

export interface OcrImageRequest {
  id: string;
  type: 'ocr-image';
  /** Encoded image bytes OR decoded pixels; pass one of them. */
  bytes?: Uint8Array;
  mime?: string;
  imageData?: ImageData;
  language: Exclude<LangKey, 'auto'>;
}

export interface AsrTranscribeRequest {
  id: string;
  type: 'transcribe';
  bytes: ArrayBuffer;
  mime: string;
  language: Exclude<LangKey, 'auto'>;
  model: AsrModelKey;
  device: 'auto' | 'wasm';
}

export type WorkerResponse = WorkerProgress | WorkerError | WorkerResult;

export interface WorkerProgress {
  id: string;
  type: 'progress';
  phase: string;
  detail?: string;
  percent?: number;
  index?: number;
  total?: number;
}

export interface WorkerError {
  id: string;
  type: 'error';
  code: string;
  message: string;
}

export type WorkerResult =
  | DocAnalyzeResult
  | OcrImageResult
  | AsrTranscribeResult;

export interface DocAnalyzeResult {
  id: string;
  type: 'analyze-result';
  kind: 'doc' | 'pdf';
  format: string;
  markdown: string;
  pageCount?: number;
  pdfType?: string;
  pagesNeedingOcr?: number[];
  hasEncodingIssues?: boolean;
  confidence?: number;
}

export interface OcrLine {
  text: string;
  confidence: number;
}

export interface OcrImageResult {
  id: string;
  type: 'ocr-result';
  text: string;
  lines: OcrLine[];
  meanConfidence: number;
  engine: string;
  language: string;
}

export interface AsrTranscribeResult {
  id: string;
  type: 'asr-result';
  text: string;
  model: string;
  language: string;
  durationSec: number;
  chunks: number;
}
