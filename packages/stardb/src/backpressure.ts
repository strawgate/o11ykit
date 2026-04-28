/**
 * Counting semaphore for worker backpressure.
 * Limits concurrent in-flight requests to prevent OOM under burst load.
 */
export class BackpressureController {
  private inflight = 0;
  private readonly waiters: Array<() => void> = [];
  private disposed = false;

  constructor(readonly maxConcurrency: number) {
    if (maxConcurrency < 1 || !Number.isFinite(maxConcurrency)) {
      throw new RangeError(`maxConcurrency must be >= 1, got ${maxConcurrency}`);
    }
  }

  /** Number of currently in-flight operations. */
  get pending(): number {
    return this.inflight;
  }

  /** Number of operations waiting for a slot. */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Acquire a slot. Resolves immediately if under limit, else waits.
   * Throws if the controller has been disposed.
   */
  async acquire(): Promise<void> {
    if (this.disposed) throw new Error("BackpressureController is disposed");
    if (this.inflight < this.maxConcurrency) {
      this.inflight++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push(() => {
        if (this.disposed) {
          reject(new Error("BackpressureController is disposed"));
        } else {
          this.inflight++;
          resolve();
        }
      });
    });
  }

  /** Release a slot and wake the next waiter. */
  release(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Reject all queued waiters and prevent new acquisitions. */
  dispose(): void {
    this.disposed = true;
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters.length = 0;
  }
}
