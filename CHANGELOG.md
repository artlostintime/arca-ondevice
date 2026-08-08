# Changelog

All notable changes to Arca are tracked here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Scanned-PDF OCR:** OCR preprocessing no longer crops the page to a tight ink-box before text detection. The PP-OCR detector is trained on page-like images, so feeding it a tight single-line crop degraded detection and scrambled the recognized words (e.g. "PAGE ONE SCAN" read as "PAGESCANONE"). Contrast stretch, deskew, and median denoise now run on the full image page-wide, so the detector keeps its page context.

### Added

- **ASR model selection (multilingual-first):** the Settings tab now offers four explicit audio models — Whisper Tiny (default) and Whisper Base (multilingual, with the UI language as a hint), plus Moonshine Tiny/Base as English-only opt-ins. `parseAsrModel` resolves a UI model key (`whisper-tiny`, `whisper-base`, `moonshine-tiny`, `moonshine-base`) into family + tier, replacing the old per-language fixed default.
- **OCR quality fallback:** after PP-OCR runs, if a page produces no lines or the mean line-confidence is below the threshold, OCR retries that page with Tesseract instead of silently returning a weak result.
- **Max input file size:** conversions reject files larger than a configurable cap (default 512 MB) with a user-readable error message.

### Changed

- **AGENTS.md** updated to reflect the multilingual-first ASR default and the quality-check-before-fallback OCR strategy.

### Removed

- **`idb` dependency** in favour of the native `IndexedDB` API. `db.ts` had a single object store and four operations (put/getAll/delete/clear), so the wrapper added weight without value. Behaviour (in-memory fallback for private mode / quota errors, fire-and-forget writes, sorted `listResults`) is preserved.
- **Dead worker-management helpers:** `disposeWorkers`, `WorkerManager.terminateAll`, and `WorkerHandle.cancel` had no callers. `env.allowLocalModels = false` was already the default in a worker context and the `env` import is no longer needed in `asr.worker.ts`.

### Refactored

- **`ModelDownloadError` class** collapsed to a plain `Error` carrying `.code = 'MODEL_DOWNLOAD'`; the class only ever held a single constant and was only caught inside the same file.
- **`fetchWithProgress`** now returns `Uint8Array` directly instead of wrapping buffered bytes in a synthetic `Response` solely so callers could call `.arrayBuffer()`; `fetchCachedModel` no longer does an extra `arrayBuffer()` round-trip.
- **`decodeText`**: `TextDecoder('utf-16le' | 'utf-16be')` already strip their own BOM, so the manual `slice(2)` is gone. UTF-8 BOM still needs an explicit slice because Node's `TextDecoder('utf-8', { ignoreBOM: true })` does not actually strip the BOM in this engine.
- **`AudioChunk` interface removed** — `chunkAudio` now returns `Float32Array[]` since only `.samples` was ever read at the call sites (worker + test).
- **`LangDef`, `OcrRecModel`, `AsrModelId`** inlined as file-private structural types; only used in their declaring module.
- **`Detected` + `toDetected` removed** — `FileTypeInfo.reason` is already optional, so `ConversionResult.detected` is now typed as `FileTypeInfo` directly.
- **`downloadText` `ext` parameter dropped** — every call site passed `'md'` and the `.txt` branch had no callers.
- **`WorkerFactory` / `CallHandlers`** no longer exported; only used inside `worker-manager.ts`.
