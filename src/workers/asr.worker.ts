/// <reference lib="webworker" />
/**
 * ASR worker. Transcribes audio using transformers.js (v4).
 *
 * Pipeline: decode → 16 kHz mono PCM → 30s chunks (2s overlap) → transcribe
 * each chunk → overlap-aware stitch. Chunking lives here (in the worker) so
 * the main thread never sees raw PCM.
 *
 * Model selection follows langs.ts: English uses Moonshine (tiny by default,
 * the smallest viable model), Hindi/Urdu use Whisper-tiny/base with the
 * matching whisper language code.
 */
import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from '@huggingface/transformers';
import { chunkAudio, decodeToPcm16k, stitchAll } from '../lib/audio';
import { effectiveKey, langDef } from '../lib/langs';
import { ASR_MODELS } from '../lib/models';
import type { AsrTranscribeRequest, WorkerError, WorkerProgress } from './comms';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

env.allowLocalModels = false;

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let loadedKey = '';

function post(data: WorkerProgress | WorkerError): void {
  ctx.postMessage(data);
}

function progress(id: string, phase: string, detail?: string, percent?: number): void {
  post({ id, type: 'progress', phase, detail, percent });
}

async function getTranscriber(id: string, modelId: string, device: 'auto' | 'wasm'): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcriber && loadedKey === modelId) return transcriber;
  if (transcriber) {
    transcriber.dispose();
    transcriber = null;
  }
  progress(id, 'loading-model', `Downloading ${modelId}…`);
  transcriber = await pipeline('automatic-speech-recognition', modelId, {
    device,
    progress_callback: (info: ProgressInfo) => {
      if (info.status === 'progress' || info.status === 'progress_total') {
        post({
          id,
          type: 'progress',
          phase: 'downloading-model',
          detail: 'file' in info ? info.file : undefined,
          percent: Math.round(info.progress ?? 0),
        });
      }
    },
  });
  loadedKey = modelId;
  return transcriber;
}

async function handle(req: AsrTranscribeRequest): Promise<void> {
  const lang = langDef(effectiveKey(req.language));
  const modelId = ASR_MODELS[lang.asrModel][req.tier];

  const trans = await getTranscriber(req.id, modelId, req.device);

  progress(req.id, 'decoding', 'Decoding audio…');
  const pcm = await decodeToPcm16k(req.bytes);
  const chunks = chunkAudio(pcm);

  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    progress(req.id, 'transcribing', `Transcribing chunk ${i + 1}/${chunks.length}…`, Math.round(((i + 1) / chunks.length) * 100));
    const kwargs: Record<string, unknown> = {};
    if (lang.whisperCode) {
      kwargs.language = lang.whisperCode;
      kwargs.task = 'transcribe';
    }
    const out = await trans(chunks[i].samples, kwargs as never);
    const text = (out as { text: string }).text ?? '';
    if (text.trim()) parts.push(text);
  }

  const fullText = stitchAll(parts);
  const durationSec = Math.round(pcm.length / 16_000);

  ctx.postMessage({
    id: req.id,
    type: 'asr-result',
    text: fullText,
    model: modelId,
    language: lang.key,
    durationSec,
    chunks: chunks.length,
  });
}

ctx.onmessage = (ev: MessageEvent<AsrTranscribeRequest>) => {
  handle(ev.data).catch((e) => {
    ctx.postMessage({
      id: ev.data.id,
      type: 'error',
      code: (e as { code?: string })?.code ?? 'internal',
      message: (e as Error)?.message ?? String(e),
    } as WorkerError);
  });
};
