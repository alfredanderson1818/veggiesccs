import { roundMoney } from './money.mjs';

// Fase 6: Documentos. Numeracion correlativa por tipo y snapshot del pedido
// para que el documento no cambie aunque luego se edite el pedido.

export const DOCUMENT_TYPES = {
  cotizacion: { prefix: 'COT', label: 'Cotizacion' },
  nota_entrega: { prefix: 'NE', label: 'Nota de entrega' },
  factura: { prefix: 'FAC', label: 'Factura interna' },
  recibo: { prefix: 'REC', label: 'Recibo de pago' }
};

export function nextDocumentNumber(documents, type) {
  const def = DOCUMENT_TYPES[type];
  if (!def) throw new Error(`Tipo de documento invalido: ${type}`);
  const count = documents.filter((doc) => doc.type === type).length + 1;
  return `${def.prefix}-${String(count).padStart(4, '0')}`;
}

export function createDocument({ order, type, number, issuedAt }) {
  const def = DOCUMENT_TYPES[type];
  if (!def) throw new Error(`Tipo de documento invalido: ${type}`);

  return {
    id: crypto.randomUUID(),
    type,
    label: def.label,
    number,
    orderId: order.id,
    orderNumber: order.orderNumber,
    customerName: (order.customerName || '').trim() || 'Mostrador',
    date: order.date,
    issuedAt: issuedAt ?? new Date().toISOString(),
    exchangeRate: order.exchangeRate?.value ?? null,
    items: order.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
      priceUsd: item.priceUsd,
      totalUsd: roundMoney(item.quantity * item.priceUsd)
    })),
    totals: order.totals ? { ...order.totals } : null,
    payment: order.payment ? { ...order.payment } : null
  };
}
