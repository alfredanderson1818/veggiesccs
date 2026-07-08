import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrderDraft,
  addItemToOrder,
  calculateOrderTotals,
  getFulfillmentImpact,
  finalizeOrder
} from './order.mjs';

const products = {
  onDemand: {
    id: 'p-ahuyama',
    sku: 'VC003',
    name: 'Ahuyama',
    unit: 'Kg',
    priceUsd: 0.9,
    estimatedCostUsd: 0.58,
    controlMode: 'on_demand',
    stock: 947.6,
    supplierName: 'Galpon Principal'
  },
  inventory: {
    id: 'p-aceite',
    sku: 'VC020',
    name: 'Aceite',
    unit: 'Und',
    priceUsd: 6.8,
    estimatedCostUsd: 5.2,
    controlMode: 'inventory',
    stock: 12,
    supplierName: 'Distribuidora Centro'
  }
};

test('calculates USD and VES totals with exchange rate snapshot', () => {
  let order = createOrderDraft({
    orderNumber: 582,
    exchangeRate: { value: 567.68, source: 'manual', date: '2026-06-08' }
  });

  order = addItemToOrder(order, products.onDemand, 3);
  order = addItemToOrder(order, products.inventory, 2);

  const totals = calculateOrderTotals(order);

  assert.equal(totals.subtotalUsd, 16.3);
  assert.equal(totals.totalUsd, 16.3);
  assert.equal(totals.totalVes, 9253.18);
  assert.equal(totals.estimatedCostUsd, 12.14);
  assert.equal(totals.estimatedMarginUsd, 4.16);
});

test('adds IVA and IGTF when tax toggles are enabled', () => {
  let order = createOrderDraft({
    orderNumber: 583,
    exchangeRate: { value: 567.68, source: 'bcv', date: '2026-06-08' },
    applyIva: true,
    applyIgtf: true
  });

  order = addItemToOrder(order, products.onDemand, 10);

  const totals = calculateOrderTotals(order);

  assert.equal(totals.subtotalUsd, 9);
  assert.equal(totals.ivaUsd, 1.44);
  assert.equal(totals.igtfUsd, 0.27);
  assert.equal(totals.totalUsd, 10.71);
  assert.equal(totals.totalVes, 6079.85);
});

test('on-demand products create supplier fulfillment without reducing inventory', () => {
  const impact = getFulfillmentImpact(products.onDemand, 20);

  assert.equal(impact.affectsInventory, false);
  assert.equal(impact.createsSupplierOrder, true);
  assert.equal(impact.quantityToPrepare, 20);
  assert.equal(impact.stockAfterSale, 947.6);
});

test('inventory products reduce stock when sold', () => {
  const impact = getFulfillmentImpact(products.inventory, 5);

  assert.equal(impact.affectsInventory, true);
  assert.equal(impact.createsSupplierOrder, false);
  assert.equal(impact.stockAfterSale, 7);
});

test('finalizes paid order with payment snapshot and immutable totals', () => {
  let order = createOrderDraft({
    orderNumber: 584,
    exchangeRate: { value: 567.68, source: 'manual', date: '2026-06-08' }
  });

  order = addItemToOrder(order, products.onDemand, 1);
  const finalized = finalizeOrder(order, {
    methodId: 'pago-movil',
    methodName: 'Pago Movil',
    amountUsd: 0.9,
    reference: 'A1B2C3'
  });

  assert.equal(finalized.status, 'paid');
  assert.equal(finalized.payment.methodName, 'Pago Movil');
  assert.equal(finalized.payment.amountVes, 510.91);
  assert.equal(finalized.totals.totalUsd, 0.9);
  assert.equal(finalized.payment.splits, null);
});

test('finalizes with mixed payment splits (per-split USD and Bs)', () => {
  let order = createOrderDraft({
    orderNumber: 585,
    exchangeRate: { value: 567.68, source: 'manual', date: '2026-06-08' }
  });
  order = addItemToOrder(order, products.onDemand, 10); // 10 * 0.9 = 9.00

  const finalized = finalizeOrder(order, {
    methodId: 'mixto',
    methodName: 'Mixto',
    amountUsd: 9,
    splits: [
      { methodId: 'zelle', methodName: 'Zelle', accountId: 'acc-usd', currency: 'USD', amountUsd: 6 },
      { methodId: 'bs', methodName: 'Caja Bs', accountId: 'acc-ves', currency: 'VES', amountUsd: 3 },
      { methodId: 'x', methodName: 'Vacio', accountId: 'acc-x', currency: 'USD', amountUsd: 0 }
    ]
  });

  assert.equal(finalized.payment.methodName, 'Mixto');
  assert.equal(finalized.payment.splits.length, 2); // el parcial en 0 se descarta
  const [s0, s1] = finalized.payment.splits;
  assert.equal(s0.methodName, 'Zelle');
  assert.equal(s0.amountUsd, 6);
  assert.equal(s1.currency, 'VES');
  assert.equal(s1.amountVes, 1703.04); // 3 * 567.68
  const sumUsd = finalized.payment.splits.reduce((acc, s) => acc + s.amountUsd, 0);
  assert.equal(sumUsd, finalized.totals.totalUsd);
});
