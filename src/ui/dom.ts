/** Tiny DOM helpers. No framework — build nodes directly, escape everything. */

/** Material Symbols outlined icon (ligature font). */
export function icon(name: string): HTMLElement {
  return el('span', { class: 'material-symbols-outlined', 'aria-hidden': 'true' }, [name]);
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type AttrValue = string | number | boolean | ((e: Event) => void);

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') {
      node.className = String(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value as (e: Event) => void);
    } else if (typeof value === 'boolean') {
      (node as unknown as Record<string, boolean>)[key] = value;
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(child));
  }
  return node;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export type ToastKind = 'ok' | 'err';

/** Transient bottom toast; kind prepends an icon. */
export function toast(message: string, kind?: ToastKind): void {
  if (toastTimer) clearTimeout(toastTimer);
  document.querySelector('.toast')?.remove();
  const parts: (Node | string)[] = [];
  if (kind) parts.push(icon(kind === 'ok' ? 'check_circle' : 'error'));
  parts.push(message);
  const node = el('div', { class: `toast${kind ? ` ${kind}` : ''}` }, parts);
  document.body.appendChild(node);
  toastTimer = setTimeout(() => node.remove(), 2400);
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let confirmTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Two-step destructive confirmation: the first click flips the button to
 * "Sure?" for 2s; a second click within that window runs the action.
 * Any other interaction (blur, pointer elsewhere, timeout) cancels it.
 */
export function confirmButton(btn: HTMLButtonElement, onConfirm: () => void, message = 'Sure?'): void {
  const original = btn.textContent ?? '';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.dataset.armed === '1') {
      btn.dataset.armed = '';
      btn.classList.remove('confirming');
      btn.textContent = original;
      onConfirm();
      return;
    }
    btn.dataset.armed = '1';
    btn.classList.add('confirming');
    btn.textContent = message;
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      btn.dataset.armed = '';
      btn.classList.remove('confirming');
      btn.textContent = original;
    }, 2000);
  });
  btn.addEventListener('blur', () => {
    btn.dataset.armed = '';
    btn.classList.remove('confirming');
    btn.textContent = original;
  });
}
