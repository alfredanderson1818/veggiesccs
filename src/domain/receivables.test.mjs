import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReceivable,
  receivableBalance,
  paidAmount,
  addAbono,
  receivablesSummary,
  isOverdue
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

test('due date: stores it, flags overdue only while unpaid', () => {
  const r = createReceivable({ order, customer, dueDate: '2026-07-10' });
  assert.equal(r.dueDate, '2026-07-10');
  assert.equal(isOverdue(r, '2026-07-09'), false); // aun no vence
  assert.equal(isOverdue(r, '2026-07-10'), false); // vence hoy, no esta vencida
  assert.equal(isOverdue(r, '2026-07-11'), true); // ya paso

  const { receivable: paid } = addAbono(r, { amountUsd: 100, methodName: 'Zelle' });
  assert.equal(isOverdue(paid, '2026-07-20'), false); // pagada nunca esta vencida

  const sinFecha = createReceivable({ order, customer });
  assert.equal(sinFecha.dueDate, null);
  assert.equal(isOverdue(sinFecha, '2030-01-01'), false);
});

test('summary reports overdue balance and count', () => {
  const a = createReceivable({ order, customer, dueDate: '2026-07-01' }); // vencida, debe 100
  let b = createReceivable({ order: { ...order, orderNumber: 601 }, customer, dueDate: '2026-07-01' });
  ({ receivable: b } = addAbono(b, { amountUsd: 60, methodName: 'Zelle' })); // vencida, debe 40
  const c = createReceivable({ order: { ...order, orderNumber: 602 }, customer, dueDate: '2026-12-31' }); // vigente

  const s = receivablesSummary([a, b, c], '2026-07-12');
  assert.equal(s.overdueCount, 2);
  assert.equal(s.overdueUsd, 140);
  assert.equal(s.balanceUsd, 240);
});
