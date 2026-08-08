# AGENTS.md — Arca

Persistent instructions for any AI coding agent working in this repository.

## Non-negotiable principles (verbatim — do not weaken)

1. **100% client-side.** No file, chunk, or byte of user content ever leaves the browser. No analytics that touch content. No error logging that includes file content.
2. **No servers, no API keys, no backend.** Static site only. If the agent proposes "a small backend for X," that's a violation — push back and ask for a client-side alternative.
3. **Smallest viable model wins — multilingual-first.** Default ASR is Whisper Tiny (multilingual). Moonshine Tiny is an explicit opt-in for English-only speed, never the default. OCR defaults to PP-OCR mobile models with a quality-based Tesseract fallback. Bigger models are opt-in, never default.
4. **Every heavy computation runs in a Web Worker.** Nothing blocks the main thread.
5. **Graceful degradation, not hard failure.** WebGPU → WebNN (if available) → WASM. If a browser lacks a feature, the app should still work, just slower — never show a blank error screen.

## Session one-liner

> "Client-side-only converter: anydoc for docs, RapidOCR/Tesseract for images, Whisper Tiny multilingual ASR by default (Moonshine English-only opt-in), everything in Web Workers, no server ever, smallest viable model wins, quality check before falling back to a stronger path, handle every edge case explicitly before adding new features."

## Engineering rules for agents

- Detect file type by content (magic bytes / ZIP content-type), never by extension or MIME trust. Route: PDF → pdf-inspector; office formats → anydoc; images → PP-OCR (quality-based Tesseract fallback); audio/video → Whisper (multilingual default) / Moonshine (English-only opt-in).
- Scanned/mixed PDFs: `pdf-inspector` gives per-page `pagesNeedingOcr`. OCR those pages and merge in page order. Never return blank output for a scanned PDF.
- Chunk long audio (30s windows, ~2s overlap) and stitch transcripts; never silently truncate.
- Enforce a configurable max file size (default 512 MB) with a user-readable error; never `arrayBuffer()` huge files when streaming/slicing is possible.
- Every worker call must be timeout-guarded (60s inactivity) and every catch must produce a UI state, never just a console.log.
- Hindi (Devanagari) and Urdu (Arabic-script/RTL) are core, not edge cases. No English-only assumptions in UI strings, text direction, or model defaults.
- Models download once from CDN, then are cached (Cache API + service worker) for offline use. Handle the fetch-failure path with a clear "connect to internet to download models" message.
- IndexedDB: write records only after a job fully completes. If storage is unavailable (private mode / quota), fall back to in-memory-only with a warning.
- Never swallow errors, never load big models by default, never put inference on the main thread "for now."

## Commands

- `npm.cmd run dev` — dev server (npm .ps1 shim is blocked by execution policy; always use `npm.cmd`).
- `npm.cmd run build` — typecheck + production build.
- `npm.cmd test` — unit tests (Vitest).
- `npm.cmd run typecheck` — TypeScript only.
