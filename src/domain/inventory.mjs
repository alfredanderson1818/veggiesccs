import { roundMoney } from './money.mjs';

// Fase 4: Inventario opcional.
// Regla central: SOLO los productos en modo 'inventory' afectan stock.
// Los productos 'on_demand' (bajo pedido) generan orden al galpon y NUNCA descuentan stock.
// 'service' y 'no_inventory' tampoco afectan stock.

const DEFAULT_MIN_STOCK = 5;

export function isInventoryProduct(product) {
  return product?.controlMode === 'inventory';
}

function normalizeQuantity(value) {
  return roundMoney(Math.max(0, Number(value || 0)));
}

export function createPurchaseMovement({ product, quantity, unitCostUsd, note }) {
  const qty = normalizeQuantity(quantity);
  return {
    id: crypto.randomUUID(),
    productId: product.id,
    sku: product.sku,
    name: product.name,
    type: 'purchase',
    quantity: qty,
    unitCostUsd: roundMoney(Number(unitCostUsd ?? product.estimatedCostUsd ?? 0)),
    note: note || `Compra de inventario · ${product.name}`,
    createdAt: new Date().toISOString()
  };
}

export function createSaleMovementsFromSale(saleOrder) {
  return saleOrder.items
    .filter((item) => item.controlMode === 'inventory')
    .map((item) => ({
      id: crypto.randomUUID(),
      productId: item.productId,
      sku: item.sku,
      name: item.name,
      type: 'sale',
      quantity: -normalizeQuantity(item.quantity),
      unitCostUsd: roundMoney(Number(item.estimatedCostUsd || 0)),
      note: `Venta Pedido #${saleOrder.orderNumber}`,
      orderId: saleOrder.id,
      createdAt: new Date().toISOString()
    }));
}

export function createReturnMovements(items, note) {
  return items
    .filter((item) => item.controlMode === 'inventory')
    .map((item) => ({
      id: crypto.randomUUID(),
      productId: item.productId,
      sku: item.sku,
      name: item.name,
      type: 'return',
      quantity: normalizeQuantity(item.quantity),
      unitCostUsd: roundMoney(Number(item.estimatedCostUsd || 0)),
      note,
      createdAt: new Date().toISOString()
    }))
    .filter((movement) => movement.quantity > 0);
}

export function createInventoryAdjustment({ product, quantity, note }) {
  return {
    id: crypto.randomUUID(),
    productId: product.id,
    sku: product.sku,
    name: product.name,
    type: 'adjustment',
    quantity: roundMoney(Number(quantity || 0)),
    unitCostUsd: roundMoney(Number(product.estimatedCostUsd || 0)),
    note: note || 'Ajuste manual de inventario',
    createdAt: new Date().toISOString()
  };
}

export function applyInventoryMovements(products, movements) {
  return products.map((product) => {
    if (!isInventoryProduct(product)) return product;
    const delta = movements
      .filter((movement) => movement.productId === product.id)
      .reduce((sum, movement) => sum + Number(movement.quantity || 0), 0);
    if (delta === 0) return product;
    const current = Number(product.stock ?? 0);
    return { ...product, stock: roundMoney(current + delta) };
  });
}

export function lowStockProducts(products) {
  return products.filter((product) => {
    if (!isInventoryProduct(product)) return false;
    const minStock = Number(product.minStock ?? DEFAULT_MIN_STOCK);
    return Number(product.stock ?? 0) <= minStock;
  });
}

export function buildProductKardex(product, movements) {
  const lines = movements.filter((movement) => movement.productId === product.id);
  const entries = roundMoney(
    lines.filter((line) => line.quantity > 0 && line.type !== 'adjustment').reduce((sum, line) => sum + line.quantity, 0)
  );
  const exits = roundMoney(
    lines.filter((line) => line.quantity < 0 && line.type !== 'adjustment').reduce((sum, line) => sum + Math.abs(line.quantity), 0)
  );
  const adjustments = roundMoney(
    lines.filter((line) => line.type === 'adjustment').reduce((sum, line) => sum + line.quantity, 0)
  );
  const final = roundMoney(Number(product.stock ?? 0));
  const initial = roundMoney(final - entries + exits - adjustments);

  return { productId: product.id, sku: product.sku, name: product.name, initial, entries, exits, adjustments, final };
}

export function summarizeInventory(products) {
  const inventoryProducts = products.filter(isInventoryProduct);
  const valueUsd = roundMoney(
    inventoryProducts.reduce(
      (sum, product) => sum + Number(product.stock ?? 0) * Number(product.estimatedCostUsd || 0),
      0
    )
  );
  return {
    productCount: inventoryProducts.length,
    lowStockCount: lowStockProducts(products).length,
    valueUsd
  };
}
