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
