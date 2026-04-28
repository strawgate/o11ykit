import { BackpressureController } from "stardb";
import { describe, expect, it } from "vitest";

describe("BackpressureController", () => {
  // ── Construction ────────────────────────────────────────────────

  describe("constructor", () => {
    it("throws on maxConcurrency < 1", () => {
      expect(() => new BackpressureController(0)).toThrow(RangeError);
      expect(() => new BackpressureController(-1)).toThrow(RangeError);
    });

    it("throws on non-finite maxConcurrency", () => {
      expect(() => new BackpressureController(Number.NaN)).toThrow(RangeError);
      expect(() => new BackpressureController(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });

    it("accepts maxConcurrency = 1", () => {
      expect(() => new BackpressureController(1)).not.toThrow();
    });
  });

  // ── Acquire / Release ──────────────────────────────────────────

  describe("acquire/release", () => {
    it("resolves immediately when under limit", async () => {
      const ctrl = new BackpressureController(2);
      await ctrl.acquire();
      expect(ctrl.pending).toBe(1);
      expect(ctrl.waiting).toBe(0);
    });

    it("release decrements pending count", async () => {
      const ctrl = new BackpressureController(2);
      await ctrl.acquire();
      ctrl.release();
      expect(ctrl.pending).toBe(0);
    });

    it("release never goes below zero", () => {
      const ctrl = new BackpressureController(2);
      ctrl.release();
      expect(ctrl.pending).toBe(0);
    });

    it("blocks when at max concurrency and unblocks on release", async () => {
      const ctrl = new BackpressureController(1);
      await ctrl.acquire(); // slot 1 taken

      let blocked = true;
      const p = ctrl.acquire().then(() => {
        blocked = false;
      });

      // Still blocked because we haven't released
      expect(ctrl.waiting).toBe(1);
      expect(blocked).toBe(true);

      ctrl.release();
      await p;
      expect(blocked).toBe(false);
      expect(ctrl.pending).toBe(1);
      expect(ctrl.waiting).toBe(0);
    });

    it("wakes waiters in FIFO order", async () => {
      const ctrl = new BackpressureController(1);
      await ctrl.acquire();

      const order: number[] = [];
      const p1 = ctrl.acquire().then(() => order.push(1));
      const p2 = ctrl.acquire().then(() => order.push(2));

      expect(ctrl.waiting).toBe(2);

      ctrl.release(); // wake first
      await p1;
      ctrl.release(); // wake second
      await p2;

      expect(order).toEqual([1, 2]);
    });
  });

  // ── Counters ───────────────────────────────────────────────────

  describe("pending/waiting counters", () => {
    it("tracks pending and waiting accurately under load", async () => {
      const ctrl = new BackpressureController(2);
      await ctrl.acquire();
      await ctrl.acquire();
      expect(ctrl.pending).toBe(2);
      expect(ctrl.waiting).toBe(0);

      const p = ctrl.acquire();
      expect(ctrl.waiting).toBe(1);
      expect(ctrl.pending).toBe(2);

      ctrl.release();
      await p;
      expect(ctrl.pending).toBe(2);
      expect(ctrl.waiting).toBe(0);

      ctrl.release();
      ctrl.release();
      expect(ctrl.pending).toBe(0);
    });
  });

  // ── Dispose ────────────────────────────────────────────────────

  describe("dispose", () => {
    it("rejects queued waiters", async () => {
      const ctrl = new BackpressureController(1);
      await ctrl.acquire();

      const p = ctrl.acquire();
      ctrl.dispose();

      await expect(p).rejects.toThrow("BackpressureController is disposed");
    });

    it("prevents new acquisitions", async () => {
      const ctrl = new BackpressureController(2);
      ctrl.dispose();
      await expect(ctrl.acquire()).rejects.toThrow("BackpressureController is disposed");
    });

    it("clears waiter queue on dispose", async () => {
      const ctrl = new BackpressureController(1);
      await ctrl.acquire();

      const p1 = ctrl.acquire();
      const p2 = ctrl.acquire();
      expect(ctrl.waiting).toBe(2);

      ctrl.dispose();
      expect(ctrl.waiting).toBe(0);

      await expect(p1).rejects.toThrow("disposed");
      await expect(p2).rejects.toThrow("disposed");
    });
  });
});
