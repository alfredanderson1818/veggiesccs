import { roundMoney } from './money.mjs';

const STATUS_FLOW = {
  pending: ['prepared'],
  prepared: ['picked_up'],
  picked_up: ['delivered'],
  delivered: []
};

export function createSupplierOrdersFromSale(saleOrder) {
  const onDemandItems = saleOrder.items.filter((item) => item.controlMode === 'on_demand');
  if (!onDemandItems.length) return [];

  const bySupplier = new Map();
  onDemandItems.forEach((item) => {
    const supplierName = item.supplierName || 'Proveedor sin asignar';
    const group = bySupplier.get(supplierName) || [];
    group.push(item);
    bySupplier.set(supplierName, group);
  });

  return Array.from(bySupplier.entries()).map(([supplierName, items]) => {
    const mappedItems = items.map((item) => ({
      saleItemId: item.id,
      productId: item.productId,
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      requestedQuantity: item.quantity,
      saleUnitPriceUsd: item.priceUsd,
      estimatedUnitCostUsd: item.estimatedCostUsd,
      actualQuantity: item.quantity,
      actualUnitCostUsd: item.estimatedCostUsd
    }));
    const estimatedCostUsd = roundMoney(
      mappedItems.reduce((sum, item) => sum + item.requestedQuantity * item.estimatedUnitCostUsd, 0)
    );
    const estimatedRevenueUsd = roundMoney(
      mappedItems.reduce((sum, item) => sum + item.requestedQuantity * item.saleUnitPriceUsd, 0)
    );

    return {
      id: crypto.randomUUID(),
      saleOrderId: saleOrder.id,
      saleOrderNumber: saleOrder.orderNumber,
      supplierName,
      status: 'pending',
      createdAt: new Date().toISOString(),
      items: mappedItems,
      estimatedCostUsd,
      estimatedRevenueUsd,
      actualCostUsd: estimatedCostUsd
    };
  });
}

export function updateSupplierOrderActuals(supplierOrder, saleItemId, actuals) {
  const items = supplierOrder.items.map((item) =>
    item.saleItemId === saleItemId
      ? {
          ...item,
          actualQuantity: Number(actuals.actualQuantity),
          actualUnitCostUsd: Number(actuals.actualUnitCostUsd)
        }
      : item
  );
  return withActualCost({ ...supplierOrder, items });
}

export function advanceSupplierOrderStatus(supplierOrder, nextStatus) {
  const allowed = STATUS_FLOW[supplierOrder.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw new Error(`Invalid status transition from ${supplierOrder.status} to ${nextStatus}`);
  }
  return { ...supplierOrder, status: nextStatus, updatedAt: new Date().toISOString() };
}

export function calculateSupplierOrderMargin(supplierOrder) {
  const actualCostUsd = roundMoney(
    supplierOrder.items.reduce(
      (sum, item) => sum + item.actualQuantity * item.actualUnitCostUsd,
      0
    )
  );
  const revenueUsd = roundMoney(supplierOrder.estimatedRevenueUsd);
  const estimatedCostUsd = roundMoney(supplierOrder.estimatedCostUsd);
  return {
    revenueUsd,
    estimatedCostUsd,
    actualCostUsd,
    estimatedMarginUsd: roundMoney(revenueUsd - estimatedCostUsd),
    realMarginUsd: roundMoney(revenueUsd - actualCostUsd)
  };
}

function withActualCost(supplierOrder) {
  return {
    ...supplierOrder,
    actualCostUsd: roundMoney(
      supplierOrder.items.reduce(
        (sum, item) => sum + item.actualQuantity * item.actualUnitCostUsd,
        0
      )
    )
  };
}

