import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_POINTS,
  MAX_ALLOWED_POINTS,
  normalizeMaxPoints,
  validateTagFilters,
} from './shared-contract.js';

test('normalizeMaxPoints returns default when undefined', () => {
  assert.equal(normalizeMaxPoints(undefined), DEFAULT_MAX_POINTS);
});

test('normalizeMaxPoints clamps low values to one', () => {
  assert.equal(normalizeMaxPoints(0), 1);
  assert.equal(normalizeMaxPoints(-4), 1);
});

test('normalizeMaxPoints clamps high values to max allowed', () => {
  assert.equal(normalizeMaxPoints(MAX_ALLOWED_POINTS + 500), MAX_ALLOWED_POINTS);
});

test('validateTagFilters accepts string records', () => {
  assert.deepEqual(validateTagFilters({ branch: 'main', os: 'linux' }), {
    branch: 'main',
    os: 'linux',
  });
});

test('validateTagFilters rejects non-string values', () => {
  assert.throws(
    () => validateTagFilters({ branch: 42 }),
    /must have a string value/,
  );
});