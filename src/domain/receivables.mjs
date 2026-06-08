import { roundMoney } from './money.mjs';

// Cuentas por cobrar: una venta a credito genera un cobro pendiente al cliente.
// Se le abona (pagos parciales) hasta saldarlo.

export function createReceivable({ order, customer }) {
  return {
    id: crypto.randomUUID(),
    orderId: order.id,
    orderNumber: order.orderNumber,
    customerId: customer?.id || null,
    customerName: customer?.name || order.customerName || 'Cliente',
    date: order.date,
    totalUsd: roundMoney(order.totals.totalUsd),
    payments: [],
    status: 'open',
    createdAt: new Date().toISOString()
  };
}

export function paidAmount(receivable) {
  return roundMoney((receivable.payments || []).reduce((sum, p) => sum + Number(p.amountUsd || 0), 0));
}

export function receivableBalance(receivable) {
  return roundMoney(receivable.totalUsd - paidAmount(receivable));
}

export function addAbono(receivable, { amountUsd, methodName, note }) {
  const amount = roundMoney(Math.max(0, Number(amountUsd || 0)));
  const payment = {
    id: crypto.randomUUID(),
    amountUsd: amount,
    methodName: methodName || '',
    note: note || '',
    createdAt: new Date().toISOString()
  };
  const payments = [...(receivable.payments || []), payment];
  const paid = payments.reduce((sum, p) => sum + p.amountUsd, 0);
  const status = paid >= receivable.totalUsd - 0.001 ? 'paid' : 'partial';
  return { receivable: { ...receivable, payments, status }, payment };
}

export function receivablesSummary(receivables) {
  const totalUsd = roundMoney(receivables.reduce((sum, r) => sum + Number(r.totalUsd || 0), 0));
  const paidUsd = roundMoney(receivables.reduce((sum, r) => sum + paidAmount(r), 0));
  return {
    totalUsd,
    paidUsd,
    balanceUsd: roundMoney(totalUsd - paidUsd),
    openCount: receivables.filter((r) => r.status !== 'paid').length,
    totalCount: receivables.length
  };
}
