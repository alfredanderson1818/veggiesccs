import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReceivable,
  receivableBalance,
  paidAmount,
  addAbono,
  receivablesSummary
} from './receivables.mjs';

const order = {
  id: 'o-1',
  orderNumber: 600,
  date: '2026-06-08',
  customerName: 'Ana',
  totals: { totalUsd: 100 }
};
const customer = { id: 'c-1', name: 'Ana Perez' };

test('creates a receivable open with the order total', () => {
  const r = createReceivable({ order, customer });
  assert.equal(r.totalUsd, 100);
  assert.equal(r.customerId, 'c-1');
  assert.equal(r.customerName, 'Ana Perez');
  assert.equal(r.status, 'open');
  assert.equal(receivableBalance(r), 100);
});

test('partial abono leaves it partial, full abono marks it paid', () => {
  let r = createReceivable({ order, customer });
  ({ receivable: r } = addAbono(r, { amountUsd: 40, methodName: 'Zelle' }));
  assert.equal(r.status, 'partial');
  assert.equal(paidAmount(r), 40);
  assert.equal(receivableBalance(r), 60);

  ({ receivable: r } = addAbono(r, { amountUsd: 60, methodName: 'Efectivo $' }));
  assert.equal(r.status, 'paid');
  assert.equal(receivableBalance(r), 0);
  assert.equal(r.payments.length, 2);
});

test('summary aggregates totals, paid and balance', () => {
  let r1 = createReceivable({ order, customer });
  ({ receivable: r1 } = addAbono(r1, { amountUsd: 30 }));
  const r2 = createReceivable({ order: { ...order, id: 'o-2', orderNumber: 601, totals: { totalUsd: 50 } }, customer });

  const summary = receivablesSummary([r1, r2]);
  assert.equal(summary.totalUsd, 150);
  assert.equal(summary.paidUsd, 30);
  assert.equal(summary.balanceUsd, 120);
  assert.equal(summary.openCount, 2);
});
