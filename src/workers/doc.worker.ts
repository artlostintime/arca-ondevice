/// <reference lib="webworker" />
/**
 * Document worker (analyze only).
 * - anydoc-wasm: office documents (docx/pptx/xlsx/odt/rtf/epub/csv/...) → Markdown
 * - pdf-inspector-wasm: PDF classify + text extraction with per-page OCR routing
 *
 * PDF page *rendering* is done on the main thread (pdfjs-dist needs a DOM
 * canvas in v6); only the flagged pages' pixels are handed to the OCR worker.
 */
import initAnyDoc, { formatFromBytes, toMarkdownBytes } from '@firecrawl/anydoc-wasm';
import initPdf, { processPdf } from '@firecrawl/pdf-inspector-wasm';
import type { DocAnalyzeRequest, WorkerError } from './comms';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const KNOWN_FORMATS = [
  'doc', 'docx', 'odt', 'pdf', 'ppt', 'pptx', 'rtf', 'epub', 'xlsx', 'ods', 'odp', 'csv',
];

let docReady = false;
let pdfReady = false;

async function ensureAnyDoc(): Promise<void> {
  if (!docReady) {
    await initAnyDoc();
    docReady = true;
  }
}

async function ensurePdfInspector(): Promise<void> {
  if (!pdfReady) {
    await initPdf();
    pdfReady = true;
  }
}

async function handleAnalyze(req: DocAnalyzeRequest): Promise<unknown> {
  const bytes = req.bytes;
  const isPdf = req.format === 'pdf' || (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);

  if (isPdf) {
    await ensurePdfInspector();
    let result;
    try {
      result = processPdf(bytes, { includePageMarkers: true, profile: 'compact' });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/password|encrypt|not authorized/i.test(msg)) {
        throw Object.assign(new Error('This PDF is password-protected.'), { code: 'encrypted' });
      }
      throw e;
    }
    return {
      id: req.id,
      type: 'analyze-result',
      kind: 'pdf',
      format: 'pdf',
      pdfType: result.pdfType,
      pageCount: result.pageCount,
      pagesNeedingOcr: result.pagesNeedingOcr,
      markdown: result.markdown ?? '',
      hasEncodingIssues: result.hasEncodingIssues,
      confidence: result.confidence,
    };
  }

  await ensureAnyDoc();
  const detected = formatFromBytes(bytes);
  const fmt = detected ?? (KNOWN_FORMATS.includes(req.format) ? (req.format as never) : undefined);
  const markdown = toMarkdownBytes(bytes, fmt);
  if (!markdown || !markdown.trim()) {
    throw Object.assign(new Error('No text could be extracted from this document.'), { code: 'empty' });
  }
  return {
    id: req.id,
    type: 'analyze-result',
    kind: 'doc',
    format: detected ?? req.format,
    markdown,
  };
}

ctx.onmessage = (ev: MessageEvent<DocAnalyzeRequest>) => {
  const req = ev.data;
  handleAnalyze(req)
    .then((data) => ctx.postMessage(data))
    .catch((e) => {
      ctx.postMessage({
        id: req.id,
        type: 'error',
        code: (e as { code?: string })?.code ?? 'internal',
        message: (e as Error)?.message ?? String(e),
      } as WorkerError);
    });
};
