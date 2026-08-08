import type {
  WorkerCategory,
  WorkerProgress,
  WorkerRequest,
  WorkerResponse,
} from '../workers/comms';

/** Inactivity timeout per worker call. Reset by any progress message. */
const INACTIVITY_TIMEOUT_MS = 60_000;

export class WorkerCallError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkerCallError';
    this.code = code;
  }
}

export interface CallHandlers {
  onProgress?: (p: WorkerProgress) => void;
}

interface Pending {
  req: WorkerRequest;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  handlers: CallHandlers;
  timer: ReturnType<typeof setTimeout> | null;
}

class WorkerHandle {
  busy = false;
  private pending: Pending | null = null;

  constructor(
    public category: WorkerCategory,
    public worker: Worker,
  ) {
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    worker.onerror = (ev: ErrorEvent) => {
      const p = this.pending;
      if (p) {
        this.finish();
        p.reject(new WorkerCallError('worker-error', ev.message || 'Worker crashed'));
      }
    };
  }

  call(req: WorkerRequest, handlers: CallHandlers = {}): Promise<unknown> {
    if (this.busy) return Promise.reject(new Error(`worker ${this.category} is busy`));
    this.busy = true;
    return new Promise((resolve, reject) => {
      this.pending = { req, resolve, reject, handlers, timer: null };
      this.resetTimer();
      const transfer: Transferable[] = req.type === 'transcribe' ? [req.bytes] : [];
      this.worker.postMessage(req, transfer);
    });
  }

  private resetTimer(): void {
    if (this.pending) {
      if (this.pending.timer) clearTimeout(this.pending.timer);
      this.pending.timer = setTimeout(() => this.onTimeout(), INACTIVITY_TIMEOUT_MS);
    }
  }

  private onMessage(data: WorkerResponse): void {
    if (!this.pending || data.id !== this.pending.req.id) return;
    if (data.type === 'progress') {
      this.resetTimer();
      this.pending.handlers.onProgress?.(data);
      return;
    }
    if (this.pending.timer) clearTimeout(this.pending.timer);
    if (data.type === 'error') {
      const p = this.pending;
      const e = new WorkerCallError(data.code, data.message);
      this.finish();
      p?.reject(e);
      return;
    }
    this.pending.resolve(data);
    this.finish();
  }

  private onTimeout(): void {
    const p = this.pending;
    this.finish();
    this.terminate();
    p?.reject(new WorkerCallError('timeout', `Worker (${this.category}) did not respond in ${INACTIVITY_TIMEOUT_MS / 1000}s — terminated`));
  }

  private finish(): void {
    this.busy = false;
    this.pending = null;
  }

  cancel(code = 'cancelled', message = 'Cancelled'): void {
    const p = this.pending;
    this.finish();
    this.terminate();
    p?.reject(new WorkerCallError(code, message));
  }

  terminate(): void {
    try {
      this.worker.terminate();
    } catch {
      /* ignore */
    }
  }
}

export type WorkerFactory = (category: WorkerCategory) => Worker;

export class WorkerManager {
  private handles: Partial<Record<WorkerCategory, WorkerHandle>> = {};

  constructor(private factory: WorkerFactory) {}

  call<T>(
    category: WorkerCategory,
    req: WorkerRequest,
    handlers: CallHandlers = {},
  ): Promise<T> {
    return this.getOrCreate(category).call(req, handlers) as Promise<T>;
  }

  private getOrCreate(category: WorkerCategory): WorkerHandle {
    let h = this.handles[category];
    if (!h) {
      h = new WorkerHandle(category, this.factory(category));
      this.handles[category] = h;
    }
    return h;
  }

  terminateAll(): void {
    for (const key of Object.keys(this.handles) as WorkerCategory[]) {
      this.handles[key]?.terminate();
      delete this.handles[key];
    }
  }
}

/** Default factory: spawn Vite-bundled module workers. */
export function createWorker(category: WorkerCategory): Worker {
  switch (category) {
    case 'doc':
      return new Worker(new URL('../workers/doc.worker.ts', import.meta.url), { type: 'module' });
    case 'ocr':
      return new Worker(new URL('../workers/ocr.worker.ts', import.meta.url), { type: 'module' });
    default:
      return new Worker(new URL('../workers/asr.worker.ts', import.meta.url), { type: 'module' });
  }
}
