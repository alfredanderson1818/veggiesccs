import { roundMoney } from './money.mjs';

// Fase 5: Reportes. Funciones puras que agregan ventas finalizadas (orders)
// y, cuando aplica, costos reales del galpon (supplierOrders) para utilidad real.

function paidOrders(orders) {
  return orders.filter((order) => order.status === 'paid' && order.totals);
}

function sortByKeyDesc(rows, key) {
  return [...rows].sort((a, b) => b[key] - a[key]);
}

export function salesByDay(orders) {
  const map = new Map();
  paidOrders(orders).forEach((order) => {
    const key = order.date;
    const row = map.get(key) || { date: key, count: 0, salesUsd: 0, marginUsd: 0 };
    row.count += 1;
    row.salesUsd += order.totals.totalUsd;
    row.marginUsd += order.totals.estimatedMarginUsd;
    map.set(key, row);
  });
  return Array.from(map.values())
    .map((row) => ({ ...row, salesUsd: roundMoney(row.salesUsd), marginUsd: roundMoney(row.marginUsd) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function salesByMonth(orders) {
  const map = new Map();
  paidOrders(orders).forEach((order) => {
    const key = (order.date || '').slice(0, 7);
    const row = map.get(key) || { month: key, count: 0, salesUsd: 0, marginUsd: 0 };
    row.count += 1;
    row.salesUsd += order.totals.totalUsd;
    row.marginUsd += order.totals.estimatedMarginUsd;
    map.set(key, row);
  });
  return Array.from(map.values())
    .map((row) => ({ ...row, salesUsd: roundMoney(row.salesUsd), marginUsd: roundMoney(row.marginUsd) }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
}

export function salesByChannel(orders) {
  const map = new Map();
  paidOrders(orders).forEach((order) => {
    const key = order.channel || 'Sin canal';
    const row = map.get(key) || { channel: key, count: 0, salesUsd: 0 };
    row.count += 1;
    row.salesUsd += order.totals.totalUsd;
    map.set(key, row);
  });
  return sortByKeyDesc(
    Array.from(map.values()).map((row) => ({ ...row, salesUsd: roundMoney(row.salesUsd) })),
    'salesUsd'
  );
}

export function salesByPaymentMethod(orders) {
  const map = new Map();
  paidOrders(orders).forEach((order) => {
    const key = order.payment?.methodName || 'Sin metodo';
    const row = map.get(key) || { method: key, count: 0, salesUsd: 0 };
    row.count += 1;
    row.salesUsd += order.totals.totalUsd;
    map.set(key, row);
  });
  return sortByKeyDesc(
    Array.from(map.values()).map((row) => ({ ...row, salesUsd: roundMoney(row.salesUsd) })),
    'salesUsd'
  );
}

export function topProducts(orders) {
  const map = new Map();
  paidOrders(orders).forEach((order) => {
    order.items.forEach((item) => {
      const row =
        map.get(item.productId) ||
        { productId: item.productId, name: item.name, sku: item.sku, quantity: 0, salesUsd: 0, marginUsd: 0 };
      row.quantity += Number(item.quantity || 0);
      row.salesUsd += item.quantity * item.priceUsd;
      row.marginUsd += item.quantity * (item.priceUsd - Number(item.estimatedCostUsd || 0));
      map.set(item.productId, row);
    });
  });
  return sortByKeyDesc(
    Array.from(map.values()).map((row) => ({
      ...row,
      quantity: roundMoney(row.quantity),
      salesUsd: roundMoney(row.salesUsd),
      marginUsd: roundMoney(row.marginUsd)
    })),
    'quantity'
  );
}

export function bestMarginProducts(orders) {
  return sortByKeyDesc(topProducts(orders), 'marginUsd');
}

export function frequentCustomers(orders) {
  const map = new Map();
  paidOrders(orders).forEach((order) => {
    const name = (order.customerName || '').trim() || 'Mostrador';
    const row = map.get(name) || { name, count: 0, salesUsd: 0 };
    row.count += 1;
    row.salesUsd += order.totals.totalUsd;
    map.set(name, row);
  });
  return sortByKeyDesc(
    Array.from(map.values()).map((row) => ({ ...row, salesUsd: roundMoney(row.salesUsd) })),
    'count'
  );
}

// Utilidad estimada vs real. El costo real de productos bajo pedido vive en las
// ordenes del galpon (actualCostUsd); el resto usa su costo estimado.
export function profitSummary(orders, supplierOrders = []) {
  const paid = paidOrders(orders);
  const salesUsd = roundMoney(paid.reduce((sum, order) => sum + order.totals.totalUsd, 0));
  const estimatedCostUsd = roundMoney(
    paid.reduce((sum, order) => sum + order.totals.estimatedCostUsd, 0)
  );

  const paidOrderIds = new Set(paid.map((order) => order.id));
  const supplierActualByOrder = supplierOrders
    .filter((so) => paidOrderIds.has(so.saleOrderId))
    .reduce((sum, so) => sum + Number(so.actualCostUsd || 0), 0);

  // Costo real de items que NO son bajo pedido (usan costo estimado).
  const nonDemandEstimatedCost = paid.reduce((sum, order) => {
    return (
      sum +
      order.items
        .filter((item) => item.controlMode !== 'on_demand')
        .reduce((s, item) => s + item.quantity * Number(item.estimatedCostUsd || 0), 0)
    );
  }, 0);

  const realCostUsd = roundMoney(supplierActualByOrder + nonDemandEstimatedCost);

  return {
    salesUsd,
    estimatedCostUsd,
    estimatedProfitUsd: roundMoney(salesUsd - estimatedCostUsd),
    realCostUsd,
    realProfitUsd: roundMoney(salesUsd - realCostUsd),
    orderCount: paid.length
  };
}
