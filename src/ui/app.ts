/**
 * App shell (vanilla TS). Owns the drop zone, settings, running jobs, and
 * the result/history list. All conversion happens through convertFile() in
 * lib/convert.ts, which routes to Web Workers — nothing heavy runs here.
 */
import { convertFile, fail, type ConvertProgress } from '../lib/convert';
import { addResult, clearResults, deleteResult, listResults } from '../lib/db';
import { buildZip, combinedMarkdown, uniqueZipNames, zipEntryName } from '../lib/export';
import { LANGS, effectiveKey, langDef, type LangKey } from '../lib/langs';
import { detectTextDir, downloadText, renderMarkdown } from '../lib/markdown';
import { JobPool } from '../lib/queue';
import { ASR_MODELS, ASR_SIZES, OCR_DET, OCR_REC } from '../lib/models';
import { formatBytes, type ConversionResult } from '../lib/result';
import { confirmButton, downloadBlob, el, esc, icon, toast } from './dom';

interface Settings {
  lang: LangKey;
  asrTier: 'tiny' | 'base';
  asrDevice: 'auto' | 'wasm';
}

type ViewName = 'converter' | 'settings' | 'history' | 'privacy' | 'help' | 'docs';

interface Job {
  id: string;
  name: string;
  phase: string;
  percent: number;
  detail?: string;
}

const PHASE_LABELS: Record<string, string> = {
  reading: 'Detecting…',
  analyzing: 'Extracting text…',
  preprocessing: 'Cleaning image…',
  ocr: 'Recognizing pages…',
  asr: 'Transcribing…',
  model: 'Downloading model…',
  done: 'Done',
};

export function startApp(root: HTMLElement): void {
  const settings: Settings = { lang: 'auto', asrTier: 'tiny', asrDevice: 'auto' };
  const jobs = new Map<string, Job>();
  const results: ConversionResult[] = [];
  const pool = new JobPool(2);
  let editingId: string | null = null;
  const editValue = new Map<string, string>();

  const jobsEl = el('div', { class: 'jobs' });
  const resultsListEl = el('div', { class: 'cards' });
  const filterEl = el('input', { class: 'filter', type: 'search', placeholder: 'Filter history…', 'aria-label': 'Filter history' }) as HTMLInputElement;
  let filterQuery = '';
  const clearAllBtn = el('button', {}, ['Clear all']);
  confirmButton(clearAllBtn, () => clearHistory());
  const resultsWrap = el('div', { class: 'results' }, [
    el('div', { class: 'results-head' }, [
      el('h2', {}, ['History']),
      el('div', { class: 'head-actions' }, [
        downloadAllWrap(exportZip, exportCombined),
        clearAllBtn,
      ]),
    ]),
    filterEl,
    resultsListEl,
  ]);

  const modelInfoEl = el('div', { class: 'model-info' });

  const settingsEl = el('div', { class: 'settings' }, [
    makeSelect('Language', LANGS.map((l) => ({ value: l.key, label: `${l.label} (${l.native})` })), 'auto', (v) => {
      settings.lang = v as LangKey;
      renderModelInfo();
    }),
    makeSelect('Audio model', [
      { value: 'tiny', label: 'Tiny (fast, smallest)' },
      { value: 'base', label: 'Base (more accurate)' },
    ], 'tiny', (v) => {
      settings.asrTier = v as Settings['asrTier'];
      renderModelInfo();
    }),
    makeSelect('Device', [
      { value: 'auto', label: 'Auto (GPU if available)' },
      { value: 'wasm', label: 'WASM (CPU)' },
    ], 'auto', (v) => {
      settings.asrDevice = v as Settings['asrDevice'];
      renderModelInfo();
    }),
  ]);

  const input = el('input', { type: 'file', multiple: true, accept: '', style: 'display:none' }) as HTMLInputElement;
  const dropzone = el('div', { class: 'dropzone', role: 'button', tabindex: '0' }, [
    el('div', { class: 'dz-icon' }, [icon('upload_file')]),
    el('div', { class: 'big' }, ['Drop files here or click to browse']),
    el('div', { class: 'sub' }, ['PDF · DOCX · images · audio — or paste an image from your clipboard']),
  ]);

  // --- views ---
  const navLinks = new Map<ViewName, HTMLElement>();
  const views = new Map<ViewName, HTMLElement>();

  const converterView = el('section', { class: 'view' }, [
    el('section', { class: 'hero' }, [
      el('h1', {}, ['Convert Securely. locally.']),
      el('p', {}, ['Convert documents, images, and audio to Markdown — 100% in your browser, nothing ever leaves your device.']),
      el('div', { class: 'privacy-pill' }, [icon('verified_user'), el('span', {}, ['No uploads. No servers. 100% on-device.'])]),
    ]),
    dropzone,
    jobsEl,
    resultsWrap,
  ]);

  const settingsView = el('section', { class: 'view' }, [
    el('div', { class: 'view-head' }, [
      el('h2', {}, ['Settings']),
      el('p', {}, ['These choices pick the on-device models used for conversion. Models are downloaded once, then cached.']),
    ]),
    settingsEl,
    modelInfoEl,
  ]);

  function renderModelInfo(): void {
    modelInfoEl.replaceChildren(buildModelInfo(settings));
  }
  renderModelInfo();

  const privacyView = el('section', { class: 'view' }, [
    el('h2', {}, ['Privacy']),
    el('div', { class: 'prose' }, [
      el('p', {}, ['Everything runs locally in your browser. Your files, extracted text, and results never leave this device — there are no servers, no accounts, and no analytics.']),
      el('p', {}, ['The only network activity is the one-time download of open-source ML models (OCR and speech-to-text) the first time you convert a file. After that, models are served from cache.']),
      el('p', {}, ['What is stored on this device:']),
      el('ul', {}, [
        el('li', {}, ['Your conversion history, kept in browser IndexedDB (deletable anytime via the History tab).']),
        el('li', {}, ['Downloaded models, kept in the browser cache for offline use.']),
      ]),
      el('p', {}, ['No personal data is collected, transmitted, or shared with third parties. Clearing your site data removes both history and cached models.']),
    ]),
  ]);

  const helpView = el('section', { class: 'view' }, [
    el('h2', {}, ['Help']),
    el('div', { class: 'prose' }, [
      el('h3', {}, ['How to convert']),
      el('ol', {}, [
        el('li', {}, ['Drop a file (or click the drop zone) — PDF, DOCX, images, and audio are supported.']),
        el('li', {}, ['Conversion runs fully on-device. The first time, the required model is downloaded once.']),
        el('li', {}, ['Copy the Markdown result, download it, or find it again in History.']),
      ]),
      el('h3', {}, ['Language & audio']),
      el('p', {}, ['Set your preferred recognition language, audio model size, and compute device in the Settings tab. Larger models are slower but more accurate.']),
      el('h3', {}, ['Troubleshooting']),
      el('ul', {}, [
        el('li', {}, ['Model downloads can fail with a poor connection — retry the conversion and the download resumes.']),
        el('li', {}, ['If speech recognition misses words, try the "Base" audio model or a clearer recording.']),
        el('li', {}, ['If OCR text looks wrong, ensure the file is a clean scan in a supported language.']),
      ]),
    ]),
  ]);

  const docsView = el('section', { class: 'view' }, [
    el('h2', {}, ['Documentation']),
    el('div', { class: 'prose' }, [
      el('h3', {}, ['Supported formats']),
      el('ul', {}, [
        el('li', {}, ['Documents: PDF, DOCX']),
        el('li', {}, ['Images: PNG, JPEG, TIFF, BMP']),
        el('li', {}, ['Audio: WAV, MP3, FLAC, OGG']),
        el('li', {}, ['Plain text: TXT, Markdown, CSV']),
      ]),
      el('h3', {}, ['Engines']),
      el('ul', {}, [
        el('li', {}, ['OCR: PP-OCRv3 detection + PP-OCRv5 recognition (ONNX Runtime Web), Tesseract.js fallback.']),
        el('li', {}, ['Speech-to-text: Whisper / Moonshine via transformers.js (ONNX).']),
      ]),
      el('h3', {}, ['On-device & offline']),
      el('p', {}, ['All processing happens in Web Workers — the main thread stays responsive and nothing leaves the browser. After the first download, conversion works offline.']),
      el('h3', {}, ['Model storage']),
      el('p', {}, ['OCR models are cached in the browser Cache API; speech models use IndexedDB (transformers.js cache). Both are removed when you clear site data.']),
    ]),
  ]);

  views.set('converter', converterView);
  views.set('settings', settingsView);
  views.set('privacy', privacyView);
  views.set('help', helpView);
  views.set('docs', docsView);

  function showView(name: ViewName): void {
    for (const [key, view] of views) view.classList.toggle('active', key === name);
    for (const [key, link] of navLinks) link.classList.toggle('active', key === name);
    window.scrollTo({ top: 0 });
  }

  function navLink(name: ViewName, label: string): HTMLElement {
    const link = el('a', { class: 'nav-link', href: '#', onclick: (e) => { e.preventDefault(); showView(name); } }, [label]);
    navLinks.set(name, link);
    return link;
  }

  const historyLink = el('a', {
    class: 'nav-link',
    href: '#',
    onclick: (e) => {
      e.preventDefault();
      for (const [key, view] of views) view.classList.toggle('active', key === 'converter');
      for (const [key, link] of navLinks) link.classList.toggle('active', key === 'converter');
      resultsWrap.scrollIntoView({ behavior: 'smooth' });
    },
  }, ['History']);
  navLinks.set('history', historyLink);

  root.append(
    el('header', { class: 'topbar' }, [
      el('div', { class: 'topbar-inner' }, [
        el('div', { class: 'brand' }, [
          icon('sync_alt'),
          el('span', { class: 'brand-name' }, ['Arca']),
        ]),
        el('nav', { class: 'nav' }, [
          navLink('converter', 'Converter'),
          historyLink,
          navLink('settings', 'Settings'),
        ]),
        el('div', { class: 'top-actions' }, [
          el('button', { class: 'icon-btn', title: 'Privacy', onclick: () => showView('privacy') }, [icon('security')]),
          el('button', { class: 'icon-btn', title: 'Help', onclick: () => showView('help') }, [icon('help_outline')]),
        ]),
      ]),
    ]),
    el('main', { class: 'main' }, [
      converterView,
      settingsView,
      privacyView,
      helpView,
      docsView,
    ]),
    el('footer', { class: 'footer' }, [
      el('div', { class: 'f-brand' }, ['Arca']),
      el('p', {}, [`© ${new Date().getFullYear()} Arca. No data leaves your machine.`]),
      el('div', { class: 'f-links' }, [
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); showView('privacy'); } }, ['Privacy Policy']),
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); showView('docs'); } }, ['Documentation']),
      ]),
    ]),
    input,
  );

  showView('converter');

  // --- events ---
  dropzone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files) handleFiles(Array.from(input.files));
    input.value = '';
  });

  let dragDepth = 0;
  dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    dropzone.classList.add('drag');
  });
  dropzone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('drag');
  });
  dropzone.addEventListener('dragover', (e) => e.preventDefault());
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('drag');
    if (e.dataTransfer?.files.length) handleFiles(Array.from(e.dataTransfer.files));
  });
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') input.click();
  });

  // --- full-page drag overlay ---
  const overlay = el('div', { class: 'overlay hidden' }, [
    icon('upload_file'),
    el('div', { class: 'overlay-text' }, ['Drop files anywhere']),
  ]);
  document.body.appendChild(overlay);
  let windowDragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    windowDragDepth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    windowDragDepth = Math.max(0, windowDragDepth - 1);
    if (windowDragDepth === 0) overlay.classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    windowDragDepth = 0;
    overlay.classList.add('hidden');
    dropzone.classList.remove('drag');
    if (e.dataTransfer?.files.length) handleFiles(Array.from(e.dataTransfer.files));
  });

  // --- paste-from-clipboard (screenshot → OCR) ---
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const images: File[] = [];
    for (const item of items) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) images.push(pasteFile(file));
    }
    if (!images.length) return;
    e.preventDefault();
    handleFiles(images);
  });

  filterEl.addEventListener('input', () => {
    filterQuery = filterEl.value.trim().toLowerCase();
    renderResults();
  });

  // --- logic ---
  function handleFiles(files: File[]): void {
    for (const file of files) {
      const job: Job = { id: crypto.randomUUID(), name: file.name, phase: 'reading', percent: 0 };
      jobs.set(job.id, job); // register up-front so queued jobs appear in file order
    }
    renderJobs();
    const queued = Array.from(jobs.values()).slice(-files.length);
    for (let i = 0; i < files.length; i++) {
      pool.run(() => runJob(files[i], queued[i]));
    }
  }

  async function runJob(file: File, job: Job): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await convertFile(bytes, file.name, {
        lang: settings.lang,
        asrTier: settings.asrTier,
        asrDevice: settings.asrDevice,
        onProgress: (p: ConvertProgress) => {
          job.phase = p.phase;
          job.percent = p.percent;
          job.detail = p.detail;
          renderJobs();
        },
      });
      jobs.delete(job.id);
      renderJobs();
      results.unshift(result);
      renderResults();
      if (result.status === 'ok') {
        addResult(result).catch(() => toast('History could not be saved (storage unavailable).', 'err'));
      }
    } catch (e) {
      job.phase = 'error';
      job.detail = (e as Error)?.message ?? String(e);
      renderJobs();
      results.unshift(fail(file.name, 'unexpected', job.detail));
      renderResults();
    }
  }

  function renderJobs(): void {
    jobsEl.textContent = '';
    const nodes: (Node | string)[] = [];
    let downloading = false;
    let modelDetail = '';
    const active = Array.from(jobs.values());
    for (let i = 0; i < active.length; i++) {
      const job = active[i];
      if (job.phase === 'model') {
        downloading = true;
        if (job.detail) modelDetail = job.detail;
      }
      if (job.phase === 'error') {
        nodes.push(
          el('div', { class: 'job error' }, [
            el('div', { class: 'job-main' }, [
              icon('error'),
              el('div', { class: 'job-info' }, [
                el('div', { class: 'job-name' }, [esc(job.name)]),
                el('div', { class: 'job-meta' }, [esc(job.detail ?? 'Conversion failed.')]),
              ]),
            ]),
          ]),
        );
        continue;
      }
      const label = PHASE_LABELS[job.phase] ?? job.phase;
      const right = job.detail && job.phase !== 'done' ? `${label} ${job.detail}` : label;
      const queued = i >= 2; // pool concurrency is 2; later jobs wait
      nodes.push(
        el('div', { class: 'job' }, [
          el('div', { class: 'job-main' }, [
            icon('description'),
            el('div', { class: 'job-info' }, [
              el('div', { class: 'job-name' }, [
                esc(job.name),
                queued ? el('span', { class: 'queued-badge' }, ['QUEUED']) : '',
              ]),
              el('div', { class: 'job-meta' }, [esc(right)]),
            ]),
            el('span', { class: 'job-pct' }, [`${Math.max(0, Math.min(100, Math.round(job.percent)))}%`]),
          ]),
          el('div', { class: 'bar' }, [el('div', { style: `width:${Math.max(2, Math.min(100, job.percent))}%` })]),
        ]),
      );
    }
    if (downloading) {
      const size = modelSizeLabel(modelDetail);
      nodes.unshift(
        el('div', { class: 'preflight' }, [
          el('div', { class: 'preflight-row' }, [icon('sync'), el('span', {}, [`First-run: downloading model${size ? ` (${size})` : ''}…`])]),
          el('div', { class: 'preflight-sub' }, ['One-time download, then cached for offline use. Conversion resumes automatically.']),
        ]),
      );
    }
    jobsEl.append(...nodes);
  }

  function renderResults(): void {
    resultsListEl.textContent = '';
    if (!results.length) {
      const empty = el('div', { class: 'empty' }, [
        el('div', { class: 'empty-icon' }, [icon('upload_file')]),
        el('div', {}, ['No conversions yet. Drop a file to begin.']),
      ]);
      resultsListEl.append(empty);
      return;
    }
    let list = results;
    if (filterQuery) {
      list = results.filter(
        (r) =>
          r.fileName.toLowerCase().includes(filterQuery) ||
          r.detected.label.toLowerCase().includes(filterQuery) ||
          (r.metadata.engine ?? '').toLowerCase().includes(filterQuery) ||
          (r.status === 'error' ? (r.error?.message ?? '') : r.markdown).toLowerCase().includes(filterQuery),
      );
    }
    if (!list.length) {
      const empty = el('div', { class: 'empty' }, [
        el('div', { class: 'empty-icon' }, [icon('search_off')]),
        el('div', {}, [`No matches for “${esc(filterQuery)}”.`]),
      ]);
      resultsListEl.append(empty);
      return;
    }
    const nodes = list.map(resultCard);
    resultsListEl.append(...nodes);
  }

  function resultCard(r: ConversionResult): Node {
    const actions: (Node | string)[] = [];
    const editing = r.status === 'ok' && r.id === editingId;
    if (r.status === 'ok') {
      actions.push(
        el('button', { onclick: () => copyText(r.markdown, 'Copied markdown.') }, [icon('content_copy'), 'Copy']),
        el('button', { title: 'Copy raw text', onclick: () => copyText(rawText(r.markdown), 'Copied raw text.') }, [icon('text_snippet'), 'Raw']),
        el('button', { title: 'Copy filename', onclick: () => copyText(r.fileName, 'Copied filename.') }, [icon('drive_file_rename_outline'), 'Name']),
        el('button', { onclick: () => downloadText(r.fileName, r.markdown, 'md') }, [icon('download'), 'Download']),
      );
      if (editing) {
        actions.push(
          el('button', { class: 'primary', onclick: () => saveEdit(r.id, (editValue.get(r.id) ?? r.markdown)) }, [icon('check'), 'Save']),
          el('button', { onclick: () => cancelEdit(r.id) }, [icon('close'), 'Cancel']),
        );
      } else {
        actions.push(
          el('button', { title: 'Edit markdown', onclick: () => startEdit(r.id) }, [icon('edit'), 'Edit']),
        );
      }
    }
    const delBtn = el('button', { class: 'danger' }, [icon('delete'), 'Delete']) as HTMLButtonElement;
    confirmButton(delBtn, () => removeResult(r.id));
    actions.push(delBtn);

    const metaParts: string[] = [];
    if (r.metadata.engine) metaParts.push(shortEngine(r.metadata.engine));
    metaParts.push(formatBytes(r.metadata.sizeBytes));
    if (r.metadata.durationMs) metaParts.push(`${(r.metadata.durationMs / 1000).toFixed(1)}s duration`);
    if (r.detected.category === 'image' && r.metadata.ocr) metaParts.push(`OCR ${Math.round(r.metadata.ocr.meanConfidence * 100)}% conf`);
    const meta = metaParts.join(' • ');

    const head = el('div', { class: 'card-main' }, [
      el('div', { class: 'card-ident' }, [
        el('div', { class: 'card-icon' }, [icon(r.status === 'error' ? 'error' : 'check_circle')]),
        el('div', {}, [
          el('div', { class: 'card-title-row' }, [
            el('span', { class: 'badge' }, [esc(r.detected.label)]),
            el('p', { class: 'card-title' }, [esc(r.fileName)]),
          ]),
          meta ? el('p', { class: 'card-meta' }, [esc(meta)]) : '',
        ]),
      ]),
      el('div', { class: 'actions' }, actions),
    ]);

    const card = el('div', { class: `card${r.status === 'error' ? ' error' : ''}${editing ? ' editing' : ''}` }, [head]);

    if (r.status === 'error') {
      card.append(el('div', { class: 'error-msg' }, [icon('error'), el('div', {}, [esc(r.error?.message ?? 'Conversion failed.')])]));
    } else if (editing) {
      const ta = el('textarea', { class: 'edit-area', rows: '10', dir: detectTextDir(r.markdown), 'aria-label': 'Edit markdown' }) as HTMLTextAreaElement;
      ta.value = r.markdown;
      ta.addEventListener('input', () => editValue.set(r.id, ta.value));
      ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          saveEdit(r.id, ta.value);
        }
      });
      card.append(ta);
    } else {
      const body = el('div', { class: 'body copyable', dir: detectTextDir(r.markdown), title: 'Click to copy markdown' });
      body.innerHTML = renderMarkdown(r.markdown);
      body.addEventListener('click', () => copyText(r.markdown, 'Copied markdown.'));
      card.append(body);
    }

    const warnNodes: (Node | string)[] = [];
    for (const w of r.warnings) warnNodes.push(el('div', {}, [esc(w)]));
    if (warnNodes.length) card.append(el('div', { class: 'warnings' }, [icon('warning'), el('div', {}, warnNodes)]));

    return card;
  }

  async function copyText(text: string, okMessage: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage, 'ok');
    } catch {
      toast('Clipboard unavailable.', 'err');
    }
  }

  function startEdit(id: string): void {
    editingId = id;
    renderResults();
  }

  function cancelEdit(id: string): void {
    if (editingId === id) {
      editingId = null;
      editValue.delete(id);
      renderResults();
    }
  }

  function saveEdit(id: string, value: string): void {
    const r = results.find((x) => x.id === id);
    if (!r) return;
    const changed = value !== r.markdown;
    r.markdown = value.trim();
    editingId = null;
    editValue.delete(id);
    renderResults();
    if (changed) {
      addResult(r).catch(() => undefined);
      toast('Changes saved.', 'ok');
    }
  }

  async function removeResult(id: string): Promise<void> {
    const i = results.findIndex((r) => r.id === id);
    if (i >= 0) results.splice(i, 1);
    renderResults();
    deleteResult(id).catch(() => undefined);
  }

  async function clearHistory(): Promise<void> {
    if (!results.length) return;
    results.length = 0;
    renderResults();
    clearResults().catch(() => undefined);
  }

  function exportable(): ConversionResult[] {
    return results.filter((r) => r.status === 'ok');
  }

  function exportZip(): void {
    const ok = exportable();
    if (!ok.length) {
      toast('No conversions to export.', 'err');
      return;
    }
    const files = uniqueZipNames(ok.map((r) => zipEntryName(r.fileName)));
    const entries = ok.map((r, i) => ({
      name: files[i],
      data: new TextEncoder().encode(r.markdown),
    }));
    const zip = buildZip(entries);
    downloadBlob(`arca-conversions-${stamp()}.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }));
    toast(`Exported ${ok.length} file${ok.length === 1 ? '' : 's'} as ZIP.`, 'ok');
  }

  function exportCombined(): void {
    const md = combinedMarkdown(exportable());
    if (!md) {
      toast('No conversions to export.', 'err');
      return;
    }
    downloadText(`arca-conversions-${stamp()}`, md, 'md');
    toast('Exported combined Markdown.', 'ok');
  }

  // --- initial history load ---
  listResults()
    .then((list) => {
      results.push(...list);
      renderResults();
    })
    .catch(() => {
      /* storage unavailable — run in-memory only */
    });
}

interface ModelCard {
  icon: string;
  title: string;
  meta: string;
  strengths: string[];
  weaknesses: string[];
}

interface AsrProfile {
  name: string;
  strengths: string[];
  weaknesses: string[];
}

const ASR_PROFILES: Record<'moonshine' | 'whisper', Record<'tiny' | 'base', AsrProfile>> = {
  moonshine: {
    tiny: {
      name: 'Moonshine Tiny',
      strengths: [
        'Smallest and fastest model — near-real-time on CPU',
        'Strong accuracy on clear English speech',
        'Low memory use; handles long audio',
      ],
      weaknesses: [
        'English only — no Hindi or Urdu',
        'Stumbles on heavy noise or strong accents',
        'No punctuation or capitalization',
      ],
    },
    base: {
      name: 'Moonshine Base',
      strengths: [
        'Better accuracy than Tiny on difficult English',
        'Still compact and fast (~60 MB)',
        'Low memory use; handles long audio',
      ],
      weaknesses: [
        'English only — no Hindi or Urdu',
        'Slower than Tiny',
      ],
    },
  },
  whisper: {
    tiny: {
      name: 'Whisper Tiny',
      strengths: [
        'Multilingual — Hindi and Urdu supported',
        'Robust to background noise and accents',
        'Adds punctuation and capitalization',
      ],
      weaknesses: [
        'Slower than Moonshine',
        'Can invent words on silence or music',
      ],
    },
    base: {
      name: 'Whisper Base',
      strengths: [
        'Best accuracy of the four ASR models',
        'Multilingual — Hindi and Urdu supported',
        'Handles noisy recordings well',
      ],
      weaknesses: [
        'Largest and slowest option (~73 MB)',
        'Uses the most memory',
      ],
    },
  },
};

const OCR_PROFILES: Record<'en' | 'hi' | 'ur', AsrProfile> = {
  en: {
    name: 'PP-OCRv5 English recognition',
    strengths: [
      'Very fast on CPU (ONNX Runtime Web)',
      'Excellent on clean scans, screenshots, and printed text',
      'Compact — about 10 MB with detection',
    ],
    weaknesses: [
      'Handwriting and stylized fonts are unreliable',
      'Low-resolution or rotated pages hurt accuracy',
    ],
  },
  hi: {
    name: 'PP-OCRv3 Devanagari recognition',
    strengths: [
      'Native Devanagari (Hindi) script support',
      'Fast on CPU (ONNX Runtime Web)',
    ],
    weaknesses: [
      'Fewer training variants than English',
      'Mixed English/Hindi lines can confuse it',
    ],
  },
  ur: {
    name: 'PP-OCRv3 Arabic/Urdu recognition',
    strengths: [
      'Native Arabic-script (Urdu) support',
      'Right-to-left text handled end-to-end',
    ],
    weaknesses: [
      'Nastaʿlīq handwriting is poorly recognized',
      'Diacritics and vowel marks are often dropped',
    ],
  },
};

const COMPUTE_PROFILES: Record<'auto' | 'wasm', AsrProfile> = {
  auto: {
    name: 'WebGPU (Auto)',
    strengths: [
      'GPU acceleration when available — fastest option',
      'Falls back WebGPU → WebNN → WASM automatically',
    ],
    weaknesses: [
      'First run compiles GPU kernels (short delay)',
      'Not every browser or device exposes WebGPU',
    ],
  },
  wasm: {
    name: 'CPU (WASM)',
    strengths: [
      'Runs on any device — maximum compatibility',
      'Predictable performance',
    ],
    weaknesses: [
      'Slowest option — heavy CPU use on long audio',
      'Large models can feel sluggish',
    ],
  },
};

/** Settings tab: which model will actually be used, and its trade-offs. */
function buildModelInfo(settings: Settings): HTMLElement {
  const lang = effectiveKey(settings.lang);
  const def = langDef(lang);
  const asr = ASR_PROFILES[def.asrModel][settings.asrTier];
  const ocr = OCR_PROFILES[lang];
  const compute = COMPUTE_PROFILES[settings.asrDevice];

  const asrId = ASR_MODELS[def.asrModel][settings.asrTier];
  const asrSize = formatBytes(ASR_SIZES[asrId] ?? 0);
  const ocrBytes = OCR_DET.sizeBytes + (OCR_REC[lang]?.sizeBytes ?? 0);

  const card = (c: ModelCard): HTMLElement =>
    el('div', { class: 'm-card' }, [
      el('div', { class: 'm-head' }, [icon(c.icon), el('div', { class: 'm-title' }, [c.title])]),
      el('div', { class: 'm-meta' }, [c.meta]),
      el('p', { class: 'm-label' }, ['Strengths']),
      el('ul', {}, c.strengths.map((s) => el('li', {}, [el('span', { class: 'm-plus' }, ['+']), s]))),
      el('p', { class: 'm-label' }, ['Weaknesses']),
      el('ul', {}, c.weaknesses.map((w) => el('li', {}, [el('span', { class: 'm-minus' }, ['−']), w]))),
    ]);

  return el('div', { class: 'model-info-inner' }, [
    el('div', { class: 'm-note' }, [
      el('h3', {}, ['Selected models']),
      el('p', {}, ['Updates live with your choices. Sizes are what the browser downloads once, then serves from cache.']),
    ]),
    el('div', { class: 'm-grid' }, [
      card({
        icon: 'graphic_eq',
        title: `${asr.name} — speech`,
        meta: `${asrId} · ONNX int8 · ${asrSize}`,
        strengths: asr.strengths,
        weaknesses: asr.weaknesses,
      }),
      card({
        icon: 'text_fields',
        title: `${ocr.name} — text`,
        meta: `${OCR_DET.name} + recognition · ~${formatBytes(ocrBytes)}`,
        strengths: ocr.strengths,
        weaknesses: ocr.weaknesses,
      }),
      card({
        icon: 'memory',
        title: `${compute.name} — compute`,
        meta: 'Web Workers keep the UI responsive',
        strengths: compute.strengths,
        weaknesses: compute.weaknesses,
      }),
    ]),
  ]);
}

function makeSelect(
  label: string,
  options: { value: string; label: string }[],
  initial: string,
  onChange: (value: string) => void,
): HTMLElement {
  const select = el('select', {}, options.map((o) => el('option', { value: o.value }, [o.label]))) as HTMLSelectElement;
  select.value = initial;
  select.addEventListener('change', () => onChange(select.value));
  return el('label', { class: 'field' }, [el('span', {}, [label]), select]);
}

/** Timestamp used in exported archive names, e.g. 2026-08-08-1430. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const PASTE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/** Give a clipboard image a real filename so detection/routing works normally. */
function pasteFile(file: File): File {
  const ext = PASTE_EXT[file.type] ?? 'png';
  const name = `pasted-${stamp()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  return new File([file], name, { type: file.type });
}

/**
 * "Download all" dropdown with the two batch export modes: ZIP archive and
 * combined Markdown. Opens on click, closes on outside click or Escape.
 */
function downloadAllWrap(onZip: () => void, onCombined: () => void): HTMLElement {
  const btn = el('button', { class: 'dlall-btn' }, [icon('archive'), 'Download all']);
  const zipItem = el('button', { onclick: () => onZip() }, [icon('folder_zip'), 'ZIP archive']);
  const mdItem = el('button', { onclick: () => onCombined() }, [icon('article'), 'Combined Markdown']);
  const menu = el('div', { class: 'dlall-menu hidden' }, [zipItem, mdItem]);
  const wrap = el('div', { class: 'dlall' }, [btn, menu]);

  const close = () => menu.classList.add('hidden');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  window.addEventListener('click', close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  return wrap;
}

function shortEngine(engine: string): string {
  if (engine.includes('whisper')) return 'Whisper';
  if (engine.includes('moonshine')) return 'Moonshine';
  if (engine.includes('tesseract')) return 'Tesseract';
  if (engine.includes('rapidocr')) return 'RapidOCR';
  if (engine.includes('pdf-inspector')) return 'PDF';
  if (engine === 'anydoc') return 'Office';
  if (engine === 'text') return 'Text';
  return engine;
}

/** Format the catalog size for a model whose name/id appears in the detail string. */
function modelSizeLabel(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const known: { key: string; bytes: number }[] = [
    { key: OCR_DET.name, bytes: OCR_DET.sizeBytes },
    ...Object.values(OCR_REC).map((m) => ({ key: m.name, bytes: m.sizeBytes })),
    ...Object.entries(ASR_SIZES).map(([key, bytes]) => ({ key, bytes })),
  ];
  for (const { key, bytes } of known) {
    if (detail.includes(key)) return `${Math.max(1, Math.round(bytes / 1_048_576))} MB`;
  }
  return undefined;
}

/** Strip common Markdown markers for a plain-text copy (client-side only). */
function rawText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
