import test from 'node:test';
import assert from 'node:assert/strict';
import { annulOrder, createReturn } from './returns.mjs';
import { createReturnMovements, applyInventoryMovements } from './inventory.mjs';

const order = {
  id: 'o-1',
  orderNumber: 581,
  status: 'paid',
  items: [
    { productId: 'p-inv', sku: 'INV', name: 'Aceite', unit: 'Und', quantity: 4, priceUsd: 6.8, estimatedCostUsd: 5.2, controlMode: 'inventory' },
    { productId: 'p-dem', sku: 'DEM', name: 'Aguacate', unit: 'Kg', quantity: 3, priceUsd: 4.5, estimatedCostUsd: 3.35, controlMode: 'on_demand' }
  ]
};

test('annuls a paid order with reason and timestamp', () => {
  const annulled = annulOrder(order, '  Cliente cancelo  ');
  assert.equal(annulled.status, 'annulled');
  assert.equal(annulled.annulReason, 'Cliente cancelo');
  assert.ok(annulled.annulledAt);
});

test('refuses to annul an order that is not paid', () => {
  assert.throws(() => annulOrder({ ...order, status: 'draft' }));
});

test('annulment returns inventory stock only for inventory items', () => {
  const products = [
    { id: 'p-inv', controlMode: 'inventory', stock: 100, estimatedCostUsd: 5.2 },
    { id: 'p-dem', controlMode: 'on_demand', stock: 800, estimatedCostUsd: 3.35 }
  ];
  const movements = createReturnMovements(order.items, 'Anulacion Pedido #581');
  assert.equal(movements.length, 1);
  assert.equal(movements[0].quantity, 4);
  const updated = applyInventoryMovements(products, movements);
  assert.equal(updated.find((p) => p.id === 'p-inv').stock, 104);
  assert.equal(updated.find((p) => p.id === 'p-dem').stock, 800);
});

test('creates a partial return with refund and clamps to sold quantity', () => {
  const ret = createReturn(order, [
    { productId: 'p-inv', quantity: 2 },
    { productId: 'p-dem', quantity: 99 } // mas de lo vendido -> se limita a 3
  ]);
  assert.equal(ret.items.length, 2);
  assert.equal(ret.items.find((l) => l.productId === 'p-dem').quantity, 3);
  // refund = 2*6.8 + 3*4.5 = 13.6 + 13.5 = 27.1
  assert.equal(ret.refundUsd, 27.1);
});

test('ignores zero-quantity return lines', () => {
  const ret = createReturn(order, [{ productId: 'p-inv', quantity: 0 }]);
  assert.equal(ret.items.length, 0);
  assert.equal(ret.refundUsd, 0);
});
