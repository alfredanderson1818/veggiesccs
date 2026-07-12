import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPayable,
  payableBalance,
  paidAmount,
  addPago,
  payablesSummary,
  isOverdue
} from './payables.mjs';

test('creates an open payable with normalized amount', () => {
  const p = createPayable({ supplierName: ' Galpon Principal ', concept: 'Factura 001', totalUsd: 340.456, dueDate: '2026-07-15' });
  assert.equal(p.supplierName, 'Galpon Principal');
  assert.equal(p.totalUsd, 340.46);
  assert.equal(p.status, 'open');
  assert.equal(p.dueDate, '2026-07-15');
  assert.equal(payableBalance(p), 340.46);
});

test('partial pago leaves it partial, full pago marks it paid', () => {
  let p = createPayable({ supplierName: 'Frutas del Sur', totalUsd: 120 });
  ({ payable: p } = addPago(p, { amountUsd: 50, methodName: 'Zelle' }));
  assert.equal(p.status, 'partial');
  assert.equal(paidAmount(p), 50);
  assert.equal(payableBalance(p), 70);

  ({ payable: p } = addPago(p, { amountUsd: 70, methodName: 'Efectivo $' }));
  assert.equal(p.status, 'paid');
  assert.equal(payableBalance(p), 0);
  assert.equal(p.payments.length, 2);
});

test('overdue only while unpaid and past due date', () => {
  const p = createPayable({ supplierName: 'X', totalUsd: 10, dueDate: '2026-07-10' });
  assert.equal(isOverdue(p, '2026-07-10'), false);
  assert.equal(isOverdue(p, '2026-07-11'), true);
  const { payable: paid } = addPago(p, { amountUsd: 10 });
  assert.equal(isOverdue(paid, '2026-07-20'), false);
  const sinFecha = createPayable({ supplierName: 'Y', totalUsd: 5 });
  assert.equal(isOverdue(sinFecha, '2030-01-01'), false);
});

test('summary totals, balance and overdue', () => {
  const a = createPayable({ supplierName: 'A', totalUsd: 100, dueDate: '2026-07-01' }); // vencida, debe 100
  let b = createPayable({ supplierName: 'B', totalUsd: 80, dueDate: '2026-07-01' });
  ({ payable: b } = addPago(b, { amountUsd: 30 })); // vencida, debe 50
  const c = createPayable({ supplierName: 'C', totalUsd: 60, dueDate: '2026-12-31' }); // vigente

  const s = payablesSummary([a, b, c], '2026-07-12');
  assert.equal(s.totalUsd, 240);
  assert.equal(s.paidUsd, 30);
  assert.equal(s.balanceUsd, 210);
  assert.equal(s.overdueCount, 2);
  assert.equal(s.overdueUsd, 150);
  assert.equal(s.openCount, 3);
});
