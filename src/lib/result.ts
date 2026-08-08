import type { Category, FileTypeInfo } from './filetype';

export interface Detected {
  category: Category;
  format: string;
  confidence: number;
  label: string;
}

export function toDetected(info: FileTypeInfo): Detected {
  const { reason: _reason, ...rest } = info;
  return rest;
}

export interface ConversionMetadata {
  engine: string;
  fallbacksUsed: string[];
  durationMs: number;
  sizeBytes: number;
  ocr?: { meanConfidence: number };
}

export interface ConversionResult {
  id: string;
  fileName: string;
  detected: Detected;
  markdown: string;
  metadata: ConversionMetadata;
  warnings: string[];
  createdAt: number;
  status: 'ok' | 'error';
  error?: { code: string; message: string };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
