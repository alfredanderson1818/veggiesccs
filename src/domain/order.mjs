import { roundMoney, usdToVes } from './money.mjs';

const IVA_RATE = 0.16;
const IGTF_RATE = 0.03;

export function createOrderDraft(options = {}) {
  return {
    id: crypto.randomUUID(),
    orderNumber: options.orderNumber ?? Date.now(),
    date: options.date ?? new Date().toISOString().slice(0, 10),
    channel: options.channel ?? 'Mayor',
    location: options.location ?? 'Todas',
    customerName: options.customerName ?? '',
    exchangeRate: options.exchangeRate ?? {
      value: 567.68,
      source: 'manual',
      date: new Date().toISOString().slice(0, 10)
    },
    applyIva: Boolean(options.applyIva),
    applyIgtf: Boolean(options.applyIgtf),
    discountUsd: Number(options.discountUsd ?? 0),
    extraChargeUsd: Number(options.extraChargeUsd ?? 0),
    notes: options.notes ?? '',
    items: [],
    status: 'draft'
  };
}

export function addItemToOrder(order, product, quantity = 1) {
  const normalizedQuantity = Math.max(0, Number(quantity || 0));
  const existing = order.items.find((item) => item.productId === product.id);
  const nextItems = existing
    ? order.items.map((item) =>
        item.productId === product.id
          ? { ...item, quantity: roundMoney(item.quantity + normalizedQuantity) }
          : item
      )
    : [
        ...order.items,
        {
          id: crypto.randomUUID(),
          productId: product.id,
          sku: product.sku,
          name: product.name,
          unit: product.unit,
          quantity: normalizedQuantity,
          priceUsd: Number(product.priceUsd),
          estimatedCostUsd: Number(product.estimatedCostUsd || 0),
          controlMode: product.controlMode,
          supplierName: product.supplierName || ''
        }
      ];

  return { ...order, items: nextItems };
}

export function updateOrderItemQuantity(order, itemId, quantity) {
  const normalizedQuantity = Math.max(0, Number(quantity || 0));
  return {
    ...order,
    items: order.items
      .map((item) => (item.id === itemId ? { ...item, quantity: normalizedQuantity } : item))
      .filter((item) => item.quantity > 0)
  };
}

export function removeOrderItem(order, itemId) {
  return { ...order, items: order.items.filter((item) => item.id !== itemId) };
}

export function calculateOrderTotals(order) {
  const subtotalUsd = roundMoney(
    order.items.reduce((sum, item) => sum + item.quantity * item.priceUsd, 0)
  );
  const estimatedCostUsd = roundMoney(
    order.items.reduce((sum, item) => sum + item.quantity * item.estimatedCostUsd, 0)
  );
  const taxableUsd = Math.max(0, subtotalUsd - Number(order.discountUsd || 0));
  const ivaUsd = order.applyIva ? roundMoney(taxableUsd * IVA_RATE) : 0;
  const igtfUsd = order.applyIgtf ? roundMoney(taxableUsd * IGTF_RATE) : 0;
  const totalUsd = roundMoney(
    taxableUsd + ivaUsd + igtfUsd + Number(order.extraChargeUsd || 0)
  );
  const totalVes = usdToVes(totalUsd, order.exchangeRate.value);
  const estimatedMarginUsd = roundMoney(totalUsd - estimatedCostUsd);

  return {
    subtotalUsd,
    discountUsd: roundMoney(Number(order.discountUsd || 0)),
    extraChargeUsd: roundMoney(Number(order.extraChargeUsd || 0)),
    ivaUsd,
    igtfUsd,
    totalUsd,
    totalVes,
    estimatedCostUsd,
    estimatedMarginUsd
  };
}

export function getFulfillmentImpact(product, quantity) {
  const normalizedQuantity = Math.max(0, Number(quantity || 0));
  const affectsInventory = product.controlMode === 'inventory';
  const createsSupplierOrder = product.controlMode === 'on_demand';
  const stock = Number(product.stock ?? 0);

  return {
    affectsInventory,
    createsSupplierOrder,
    quantityToPrepare: createsSupplierOrder ? normalizedQuantity : 0,
    stockAfterSale: affectsInventory ? roundMoney(stock - normalizedQuantity) : stock
  };
}

// Normaliza los pagos parciales (mixto): cada uno lleva su monto en USD y su
// equivalente en Bs a la tasa del pedido, para alimentar la cuenta destino.
export function normalizePaymentSplits(splits, rate) {
  if (!Array.isArray(splits) || splits.length === 0) return null;
  return splits
    .filter((s) => Number(s.amountUsd || 0) > 0)
    .map((s) => ({
      methodId: s.methodId,
      methodName: s.methodName,
      accountId: s.accountId ?? null,
      currency: s.currency === 'VES' ? 'VES' : 'USD',
      amountUsd: roundMoney(Number(s.amountUsd || 0)),
      amountVes: usdToVes(Number(s.amountUsd || 0), rate)
    }));
}

export function finalizeOrder(order, payment) {
  const totals = calculateOrderTotals(order);
  const rate = order.exchangeRate.value;
  const splits = normalizePaymentSplits(payment.splits, rate);
  return {
    ...order,
    status: 'paid',
    totals,
    payment: {
      ...payment,
      splits,
      amountUsd: roundMoney(payment.amountUsd),
      amountVes: usdToVes(payment.amountUsd, rate)
    },
    finalizedAt: new Date().toISOString()
  };
}

