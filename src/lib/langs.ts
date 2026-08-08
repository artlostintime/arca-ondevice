export type LangKey = 'auto' | 'en' | 'hi' | 'ur';

export interface LangDef {
  key: LangKey;
  label: string;
  native: string;
  /** ASR model family for this language. */
  asrModel: 'moonshine' | 'whisper';
  /** Whisper language code (ISO-639-1). */
  whisperCode?: string;
  /** OCR recognition dict key used by the OCR worker. */
  ocrKey: 'en' | 'hi' | 'ur';
}

export const LANGS: LangDef[] = [
  { key: 'auto', label: 'Auto (English)', native: 'EN', asrModel: 'moonshine', ocrKey: 'en' },
  { key: 'en', label: 'English', native: 'EN', asrModel: 'moonshine', ocrKey: 'en' },
  { key: 'hi', label: 'Hindi', native: 'हिन्दी', asrModel: 'whisper', whisperCode: 'hi', ocrKey: 'hi' },
  { key: 'ur', label: 'Urdu', native: 'اردو', asrModel: 'whisper', whisperCode: 'ur', ocrKey: 'ur' },
];

export function langDef(key: LangKey): LangDef {
  return LANGS.find((l) => l.key === key) ?? LANGS[1];
}

/**
 * Resolve the effective OCR/ASR language. 'auto' defaults to English —
 * the smallest viable model by default (Moonshine-tiny).
 */
export function effectiveKey(key: LangKey): Exclude<LangKey, 'auto'> {
  return key === 'auto' ? 'en' : key;
}
