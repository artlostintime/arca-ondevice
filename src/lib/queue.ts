/**
 * A tiny job pool that runs at most `concurrency` jobs at once. Used to cap
 * RAM: no more than N files are processed in parallel, never "fire all
 * workers simultaneously".
 */
export class JobPool {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private concurrency = 2) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running < this.concurrency) {
      this.running++;
      return fn().finally(() => {
        this.running--;
        this.pump();
      });
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.running++;
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            this.running--;
            this.pump();
          });
      });
    });
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const next = this.queue.shift()!;
      next();
    }
  }
}
