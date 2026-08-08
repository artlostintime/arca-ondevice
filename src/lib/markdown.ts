import { marked } from 'marked';
import { esc } from '../ui/dom';
import { downloadBlob } from '../ui/dom';

const renderer = new marked.Renderer();
renderer.html = (token: unknown) => {
  const raw = typeof token === 'string' ? token : (token as { text?: string })?.text ?? '';
  return esc(raw);
};
marked.use({ gfm: true, breaks: true, renderer });

/** Render Markdown to HTML, escaping any raw HTML so user files can't inject markup. */
export function renderMarkdown(src: string): string {
  const out = marked.parse(src ?? '');
  return typeof out === 'string' ? out : String(out);
}

/** Arabic-script text (Urdu/Persian/Arabic) renders right-to-left. */
export function detectTextDir(text: string): 'rtl' | 'ltr' {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)
    ? 'rtl'
    : 'ltr';
}

export function downloadText(filename: string, text: string, ext: 'md' | 'txt'): void {
  const name = filename.endsWith('.md') || filename.endsWith('.txt')
    ? filename
    : `${filename}.${ext}`;
  downloadBlob(name, new Blob([text], { type: 'text/plain;charset=utf-8' }));
}
