import type { FileTypeInfo } from './filetype';

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
  detected: FileTypeInfo;
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
