import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPurchaseMovement,
  createSaleMovementsFromSale,
  createInventoryAdjustment,
  applyInventoryMovements,
  lowStockProducts,
  buildProductKardex,
  summarizeInventory
} from './inventory.mjs';

const products = [
  { id: 'p-inv', sku: 'INV1', name: 'Aceite', unit: 'Und', controlMode: 'inventory', stock: 10, estimatedCostUsd: 5, minStock: 4 },
  { id: 'p-demand', sku: 'DEM1', name: 'Aguacate', unit: 'Kg', controlMode: 'on_demand', stock: 800, estimatedCostUsd: 3 },
  { id: 'p-srv', sku: 'SRV1', name: 'Despacho', unit: 'Servicio', controlMode: 'service', stock: null, estimatedCostUsd: 2 }
];

test('purchase movement adds stock only to inventory product', () => {
  const movement = createPurchaseMovement({ product: products[0], quantity: 20, unitCostUsd: 5.5 });
  const updated = applyInventoryMovements(products, [movement]);
  assert.equal(updated.find((p) => p.id === 'p-inv').stock, 30);
});

test('sale movements only affect inventory items and ignore on_demand and service', () => {
  const saleOrder = {
    id: 'order-1',
    orderNumber: 700,
    items: [
      { productId: 'p-inv', sku: 'INV1', name: 'Aceite', quantity: 3, controlMode: 'inventory', estimatedCostUsd: 5 },
      { productId: 'p-demand', sku: 'DEM1', name: 'Aguacate', quantity: 50, controlMode: 'on_demand', estimatedCostUsd: 3 },
      { productId: 'p-srv', sku: 'SRV1', name: 'Despacho', quantity: 1, controlMode: 'service', estimatedCostUsd: 2 }
    ]
  };

  const movements = createSaleMovementsFromSale(saleOrder);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].quantity, -3);

  const updated = applyInventoryMovements(products, movements);
  assert.equal(updated.find((p) => p.id === 'p-inv').stock, 7);
  assert.equal(updated.find((p) => p.id === 'p-demand').stock, 800);
});

test('manual adjustment can reduce stock', () => {
  const movement = createInventoryAdjustment({ product: products[0], quantity: -2, note: 'Merma' });
  const updated = applyInventoryMovements(products, [movement]);
  assert.equal(updated.find((p) => p.id === 'p-inv').stock, 8);
});

test('detects products at or below minimum stock', () => {
  const low = [{ ...products[0], stock: 4 }, products[1], products[2]];
  const alerts = lowStockProducts(low);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, 'p-inv');
});

test('builds per-product kardex with initial, entries, exits, adjustments and final', () => {
  const product = { ...products[0], stock: 25 };
  const movements = [
    createPurchaseMovement({ product, quantity: 20, unitCostUsd: 5 }),
    { productId: 'p-inv', type: 'sale', quantity: -3 },
    createInventoryAdjustment({ product, quantity: -2, note: 'Merma' })
  ];

  const kardex = buildProductKardex(product, movements);
  assert.equal(kardex.entries, 20);
  assert.equal(kardex.exits, 3);
  assert.equal(kardex.adjustments, -2);
  assert.equal(kardex.final, 25);
  assert.equal(kardex.initial, 10);
});

test('summarizes inventory value and low stock count', () => {
  const summary = summarizeInventory(products);
  assert.equal(summary.productCount, 1);
  assert.equal(summary.valueUsd, 50);
  assert.equal(summary.lowStockCount, 0);
});
