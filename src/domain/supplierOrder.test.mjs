import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSupplierOrdersFromSale,
  updateSupplierOrderActuals,
  advanceSupplierOrderStatus,
  calculateSupplierOrderMargin
} from './supplierOrder.mjs';

const sale = {
  id: 'order-1',
  orderNumber: 600,
  date: '2026-06-08',
  totals: { totalUsd: 24.5 },
  items: [
    {
      id: 'item-1',
      productId: 'p-aguacate',
      sku: 'VC002',
      name: 'Aguacate',
      unit: 'Kg',
      quantity: 4,
      priceUsd: 4.5,
      estimatedCostUsd: 3.35,
      controlMode: 'on_demand',
      supplierName: 'Galpon Principal'
    },
    {
      id: 'item-2',
      productId: 'p-aceite',
      sku: 'VC020',
      name: 'Aceite',
      unit: 'Und',
      quantity: 1,
      priceUsd: 6.5,
      estimatedCostUsd: 5.2,
      controlMode: 'inventory',
      supplierName: 'Distribuidora Centro'
    }
  ]
};

test('creates supplier orders only for on-demand sale items', () => {
  const supplierOrders = createSupplierOrdersFromSale(sale);

  assert.equal(supplierOrders.length, 1);
  assert.equal(supplierOrders[0].saleOrderId, 'order-1');
  assert.equal(supplierOrders[0].saleOrderNumber, 600);
  assert.equal(supplierOrders[0].items[0].name, 'Aguacate');
  assert.equal(supplierOrders[0].items[0].requestedQuantity, 4);
  assert.equal(supplierOrders[0].estimatedCostUsd, 13.4);
  assert.equal(supplierOrders[0].estimatedRevenueUsd, 18);
  assert.equal(supplierOrders[0].status, 'pending');
});

test('updates actual quantity and cost for a supplier order line', () => {
  const [supplierOrder] = createSupplierOrdersFromSale(sale);
  const updated = updateSupplierOrderActuals(supplierOrder, 'item-1', {
    actualQuantity: 3.8,
    actualUnitCostUsd: 3.5
  });

  assert.equal(updated.items[0].actualQuantity, 3.8);
  assert.equal(updated.items[0].actualUnitCostUsd, 3.5);
  assert.equal(updated.actualCostUsd, 13.3);
});

test('advances supplier order status in the allowed flow', () => {
  const [supplierOrder] = createSupplierOrdersFromSale(sale);

  const prepared = advanceSupplierOrderStatus(supplierOrder, 'prepared');
  const pickedUp = advanceSupplierOrderStatus(prepared, 'picked_up');
  const delivered = advanceSupplierOrderStatus(pickedUp, 'delivered');

  assert.equal(delivered.status, 'delivered');
  assert.throws(() => advanceSupplierOrderStatus(supplierOrder, 'delivered'), /Invalid status transition/);
});

test('calculates real margin from actual galpon cost', () => {
  const [supplierOrder] = createSupplierOrdersFromSale(sale);
  const updated = updateSupplierOrderActuals(supplierOrder, 'item-1', {
    actualQuantity: 3.8,
    actualUnitCostUsd: 3.5
  });

  const margin = calculateSupplierOrderMargin(updated);

  assert.equal(margin.revenueUsd, 18);
  assert.equal(margin.estimatedCostUsd, 13.4);
  assert.equal(margin.actualCostUsd, 13.3);
  assert.equal(margin.estimatedMarginUsd, 4.6);
  assert.equal(margin.realMarginUsd, 4.7);
});

