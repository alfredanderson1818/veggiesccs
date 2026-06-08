import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordRate,
  latestRate,
  createRateAuditEntry,
  rateChanged,
  rateDifference,
  applyBsRounding
} from './rates.mjs';

test('records rates newest first and replaces same date+source', () => {
  let history = [];
  history = recordRate(history, { date: '2026-06-07', value: 560, source: 'BCV' });
  history = recordRate(history, { date: '2026-06-08', value: 567.68, source: 'BCV' });
  assert.equal(history.length, 2);
  assert.equal(history[0].date, '2026-06-08');
  // same date+source replaces, not duplicates
  history = recordRate(history, { date: '2026-06-08', value: 570, source: 'BCV' });
  assert.equal(history.length, 2);
  assert.equal(history[0].value, 570);
});

test('latestRate filters by source', () => {
  const history = [
    { date: '2026-06-08', value: 570, source: 'manual' },
    { date: '2026-06-08', value: 567.68, source: 'BCV' }
  ];
  assert.equal(latestRate(history, 'BCV').value, 567.68);
  assert.equal(latestRate(history).value, 570);
  assert.equal(latestRate([], 'BCV'), null);
});

test('detects rate changes ignoring rounding noise', () => {
  assert.equal(rateChanged(567.68, 567.68), false);
  assert.equal(rateChanged(567.68, 570), true);
});

test('audit entry captures from/to, reason and order', () => {
  const entry = createRateAuditEntry({ fromValue: 567.68, toValue: 575, reason: '  subio el dolar  ', orderNumber: 581 });
  assert.equal(entry.fromValue, 567.68);
  assert.equal(entry.toValue, 575);
  assert.equal(entry.reason, 'subio el dolar');
  assert.equal(entry.orderNumber, 581);
  assert.ok(entry.at);
});

test('computes difference between charged and BCV rate', () => {
  const diff = rateDifference(575, 567.68);
  assert.equal(diff.diffBs, 7.32);
  assert.equal(diff.percent, 1.29);
  assert.deepEqual(rateDifference(575, 0), { diffBs: 0, percent: 0 });
});

test('applies configurable Bs rounding', () => {
  assert.equal(applyBsRounding(6414.78, { step: 0 }), 6414.78);
  assert.equal(applyBsRounding(6414.78, { step: 1, mode: 'nearest' }), 6415);
  assert.equal(applyBsRounding(6414.78, { step: 5, mode: 'up' }), 6415);
  assert.equal(applyBsRounding(6414.78, { step: 10, mode: 'down' }), 6410);
  assert.equal(applyBsRounding(6414.78, { step: 10, mode: 'nearest' }), 6410);
});
