import test from 'node:test';
import assert from 'node:assert/strict';
import {
  salesByDay,
  salesByMonth,
  salesByChannel,
  salesByPaymentMethod,
  topProducts,
  bestMarginProducts,
  frequentCustomers,
  profitSummary
} from './reports.mjs';

const orders = [
  {
    id: 'o1',
    status: 'paid',
    date: '2026-06-01',
    channel: 'Mayor',
    customerName: 'Ana',
    payment: { methodName: 'Zelle' },
    totals: { totalUsd: 100, estimatedCostUsd: 60, estimatedMarginUsd: 40 },
    items: [
      { productId: 'p1', name: 'Aguacate', sku: 'A1', quantity: 10, priceUsd: 8, estimatedCostUsd: 5, controlMode: 'on_demand' },
      { productId: 'p2', name: 'Aceite', sku: 'A2', quantity: 2, priceUsd: 10, estimatedCostUsd: 5, controlMode: 'inventory' }
    ]
  },
  {
    id: 'o2',
    status: 'paid',
    date: '2026-06-01',
    channel: 'Detal',
    customerName: '',
    payment: { methodName: 'Efectivo $' },
    totals: { totalUsd: 50, estimatedCostUsd: 30, estimatedMarginUsd: 20 },
    items: [
      { productId: 'p1', name: 'Aguacate', sku: 'A1', quantity: 5, priceUsd: 8, estimatedCostUsd: 5, controlMode: 'on_demand' }
    ]
  },
  {
    id: 'o3',
    status: 'paid',
    date: '2026-05-20',
    channel: 'Mayor',
    customerName: 'Ana',
    payment: { methodName: 'Zelle' },
    totals: { totalUsd: 200, estimatedCostUsd: 120, estimatedMarginUsd: 80 },
    items: [
      { productId: 'p2', name: 'Aceite', sku: 'A2', quantity: 20, priceUsd: 10, estimatedCostUsd: 6, controlMode: 'inventory' }
    ]
  },
  { id: 'draft', status: 'draft', date: '2026-06-02', items: [] }
];

test('groups sales by day ignoring drafts, newest first', () => {
  const rows = salesByDay(orders);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-06-01');
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].salesUsd, 150);
  assert.equal(rows[0].marginUsd, 60);
});

test('groups sales by month', () => {
  const rows = salesByMonth(orders);
  assert.equal(rows[0].month, '2026-06');
  assert.equal(rows[0].salesUsd, 150);
  assert.equal(rows[1].month, '2026-05');
  assert.equal(rows[1].salesUsd, 200);
});

test('groups sales by channel sorted by sales', () => {
  const rows = salesByChannel(orders);
  assert.equal(rows[0].channel, 'Mayor');
  assert.equal(rows[0].salesUsd, 300);
  assert.equal(rows[0].count, 2);
});

test('groups sales by payment method', () => {
  const rows = salesByPaymentMethod(orders);
  assert.equal(rows[0].method, 'Zelle');
  assert.equal(rows[0].salesUsd, 300);
});

test('ranks top products by quantity sold', () => {
  const rows = topProducts(orders);
  assert.equal(rows[0].name, 'Aceite');
  assert.equal(rows[0].quantity, 22);
  assert.equal(rows[0].salesUsd, 220);
});

test('ranks products by best margin', () => {
  const rows = bestMarginProducts(orders);
  // Aceite: 2*(10-5)+20*(10-6)=10+80=90 ; Aguacate: 15*(8-5)=45
  assert.equal(rows[0].name, 'Aceite');
  assert.equal(rows[0].marginUsd, 90);
});

test('counts frequent customers, empty name becomes Mostrador', () => {
  const rows = frequentCustomers(orders);
  assert.equal(rows[0].name, 'Ana');
  assert.equal(rows[0].count, 2);
  assert.ok(rows.some((r) => r.name === 'Mostrador'));
});

test('profit summary uses supplier actual cost for on_demand and estimated for the rest', () => {
  const supplierOrders = [
    { saleOrderId: 'o1', actualCostUsd: 55 }, // aguacate real (10*5.5)
    { saleOrderId: 'o2', actualCostUsd: 30 } // aguacate real (5*6)
  ];
  const summary = profitSummary(orders, supplierOrders);
  assert.equal(summary.salesUsd, 350);
  assert.equal(summary.estimatedProfitUsd, 140);
  // real cost = supplier actual (55+30) + non-demand estimated (o1 aceite 2*5=10, o3 aceite 20*6=120) = 215
  assert.equal(summary.realCostUsd, 215);
  assert.equal(summary.realProfitUsd, 135);
});
