/**
 * Main-thread PDF page rendering for OCR routing.
 *
 * pdfjs-dist v6 requires a DOM canvas, so this runs on the main thread.
 * Parsing still happens in pdfjs's own internal worker; only the final
 * rasterization happens here. Rendering is batched to whatever page(s) the
 * doc worker flagged as needing OCR — the common case for scanned PDFs is
 * a single flatbed scan per page, so we never rasterize the whole document.
 */
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const sessions = new Map<string, PDFDocumentProxy>();

async function getDoc(sessionId: string, bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const cached = sessions.get(sessionId);
  if (cached) return cached;
  const task = getDocument({ data: bytes });
  const doc = await task.promise;
  sessions.set(sessionId, doc);
  return doc;
}

/**
 * Render one 1-indexed page to decoded pixels. Caches the loaded PDF per
 * session so multiple flagged pages reuse the same document object.
 */
export async function renderPdfPage(
  sessionId: string,
  bytes: Uint8Array,
  page: number,
  maxSide = 2200,
): Promise<ImageData> {
  const doc = await getDoc(sessionId, bytes);
  const pdfPage = await doc.getPage(page);
  const base = pdfPage.getViewport({ scale: 1 });
  const scale = Math.min(2, maxSide / Math.max(base.width, base.height));
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await pdfPage.render({ canvas, viewport }).promise;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D canvas context unavailable');
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
  return imageData;
}

/** Release a session's PDF document to free memory. */
export async function releasePdf(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  try {
    await entry.loadingTask.destroy();
  } catch {
    /* ignore */
  }
  sessions.delete(sessionId);
}
