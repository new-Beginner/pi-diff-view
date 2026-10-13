/** Concurrent bounded reads; ordered writes fence all earlier reads and later operations. */
export class ReadWriteQueue {
  private writer: Promise<unknown> = Promise.resolve();
  private readers = new Set<Promise<unknown>>();
  private active = 0;
  private waiting: Array<() => void> = [];
  pending = 0;
  constructor(private readonly concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid read concurrency');
  }
  run<T>(work: () => Promise<T>, write = false): Promise<T> {
    this.pending++;
    const result = write
      ? Promise.all([this.writer, ...this.readers].map(task => task.catch(() => undefined))).then(work)
      : this.writer.catch(() => undefined).then(async () => {
        if (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
        else this.active++;
        try { return await work(); }
        finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
      });
    if (write) this.writer = result;
    else this.readers.add(result);
    const settle = () => { this.pending--; this.readers.delete(result); };
    void result.then(settle, settle);
    return result;
  }
}
