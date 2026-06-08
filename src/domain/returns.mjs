import { roundMoney } from './money.mjs';

// Fase 6: Anulacion de pedidos y devoluciones.
// Las funciones son puras: devuelven el estado nuevo / los datos a revertir,
// y main.mjs aplica la reversa en caja, inventario y galpon.

export function annulOrder(order, reason) {
  if (order.status !== 'paid') {
    throw new Error('Solo se pueden anular pedidos finalizados');
  }
  return {
    ...order,
    status: 'annulled',
    annulReason: (reason || '').trim(),
    annulledAt: new Date().toISOString()
  };
}

export function createReturn(order, returnedItems, reason) {
  const lines = returnedItems
    .map((requested) => {
      const item = order.items.find((line) => line.productId === requested.productId);
      if (!item) throw new Error(`El producto no pertenece al pedido: ${requested.productId}`);
      const quantity = Math.min(Math.max(0, Number(requested.quantity || 0)), item.quantity);
      return {
        productId: item.productId,
        sku: item.sku,
        name: item.name,
        unit: item.unit,
        quantity: roundMoney(quantity),
        priceUsd: item.priceUsd,
        controlMode: item.controlMode,
        refundUsd: roundMoney(quantity * item.priceUsd)
      };
    })
    .filter((line) => line.quantity > 0);

  const refundUsd = roundMoney(lines.reduce((sum, line) => sum + line.refundUsd, 0));

  return {
    id: crypto.randomUUID(),
    orderId: order.id,
    orderNumber: order.orderNumber,
    reason: (reason || '').trim(),
    createdAt: new Date().toISOString(),
    items: lines,
    refundUsd
  };
}
