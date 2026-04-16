import { describe, expect, it } from 'vitest';

import {
  ok,
  err,
  isResponseEnvelope,
  labelsFromEntries,
  type RequestEnvelope,
  type ResponseEnvelope,
  type ErrorResponse,
  type InitResponse,
  type ProtocolMeta,
} from '../src/worker-protocol.js';

describe('worker-protocol helpers', () => {
  // ── ok() ──────────────────────────────────────────────────────

  describe('ok()', () => {
    it('wraps a response payload without meta', () => {
      const payload: InitResponse = { ok: true, type: 'init', backend: 'column' };
      const env = ok(42, payload);

      expect(env).toEqual({
        id: 42,
        kind: 'response',
        payload: { ok: true, type: 'init', backend: 'column' },
      });
      expect(env).not.toHaveProperty('meta');
    });

    it('includes meta when provided', () => {
      const payload: InitResponse = { ok: true, type: 'init', backend: 'column' };
      const meta: ProtocolMeta = { strategy: 'transferable', sentAt: 1000 };
      const env = ok(1, payload, meta);

      expect(env.meta).toEqual(meta);
      expect(env.id).toBe(1);
      expect(env.kind).toBe('response');
    });

    it('preserves payload type for all response types', () => {
      const echo = ok(1, { ok: true as const, type: 'echo' as const, bytes: 128 });
      expect(echo.payload.type).toBe('echo');

      const close = ok(2, { ok: true as const, type: 'close' as const });
      expect(close.payload.type).toBe('close');

      const stats = ok(3, {
        ok: true as const,
        type: 'stats' as const,
        stats: { seriesCount: 5, sampleCount: 100, memoryBytes: 2048 },
      });
      expect(stats.payload.type).toBe('stats');
    });
  });

  // ── err() ─────────────────────────────────────────────────────

  describe('err()', () => {
    it('wraps an Error instance with message and stack', () => {
      const error = new Error('something broke');
      const env = err(7, error);

      expect(env.id).toBe(7);
      expect(env.kind).toBe('response');
      expect(env.payload.ok).toBe(false);
      expect(env.payload.type).toBe('error');
      expect(env.payload.error).toBe('something broke');
      expect(env.payload.stack).toBeDefined();
      expect(env).not.toHaveProperty('meta');
    });

    it('wraps a string error without stack', () => {
      const env = err(8, 'plain string error');

      expect(env.payload.error).toBe('plain string error');
      expect(env.payload).not.toHaveProperty('stack');
    });

    it('wraps a non-Error object via String()', () => {
      const env = err(9, 42);
      expect(env.payload.error).toBe('42');
    });

    it('includes meta when provided', () => {
      const meta: ProtocolMeta = { strategy: 'structured-clone' };
      const env = err(10, new Error('oops'), meta);

      expect(env.meta).toEqual(meta);
      expect(env.payload.error).toBe('oops');
    });

    it('omits meta field when meta is undefined', () => {
      const env = err(11, 'no meta');
      expect(env).not.toHaveProperty('meta');
    });
  });

  // ── isResponseEnvelope() ──────────────────────────────────────

  describe('isResponseEnvelope()', () => {
    it('returns true for a valid response envelope', () => {
      const env: ResponseEnvelope = {
        id: 1,
        kind: 'response',
        payload: { ok: true, type: 'close' },
      };
      expect(isResponseEnvelope(env)).toBe(true);
    });

    it('returns true for an error response envelope', () => {
      const env: ResponseEnvelope<ErrorResponse> = {
        id: 2,
        kind: 'response',
        payload: { ok: false, type: 'error', error: 'fail' },
      };
      expect(isResponseEnvelope(env)).toBe(true);
    });

    it('returns false for null', () => {
      expect(isResponseEnvelope(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isResponseEnvelope(undefined)).toBe(false);
    });

    it('returns false for a primitive', () => {
      expect(isResponseEnvelope(42)).toBe(false);
      expect(isResponseEnvelope('hello')).toBe(false);
    });

    it('returns false for a request envelope', () => {
      const req: RequestEnvelope = {
        id: 1,
        kind: 'request',
        payload: { type: 'stats' },
      };
      expect(isResponseEnvelope(req)).toBe(false);
    });

    it('returns false when id is missing', () => {
      expect(isResponseEnvelope({ kind: 'response', payload: { ok: true } })).toBe(false);
    });

    it('returns false when payload is missing', () => {
      expect(isResponseEnvelope({ id: 1, kind: 'response' })).toBe(false);
    });

    it('returns false for an empty object', () => {
      expect(isResponseEnvelope({})).toBe(false);
    });
  });

  // ── labelsFromEntries() ───────────────────────────────────────

  describe('labelsFromEntries()', () => {
    it('converts label entries to a Map', () => {
      const entries: [string, string][] = [
        ['__name__', 'cpu_usage'],
        ['host', 'web-01'],
      ];
      const result = labelsFromEntries(entries);

      expect(result).toBeInstanceOf(Map);
      expect(result.get('__name__')).toBe('cpu_usage');
      expect(result.get('host')).toBe('web-01');
      expect(result.size).toBe(2);
    });

    it('returns an empty Map for empty entries', () => {
      expect(labelsFromEntries([]).size).toBe(0);
    });
  });
});
