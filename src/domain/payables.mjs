import { roundMoney } from './money.mjs';

// Cuentas por pagar: lo que el negocio le debe a sus proveedores.
// Se registran manualmente o desde una orden del galpon, y se les hacen
// pagos (salidas de caja) hasta saldarlas.

export function createPayable({ supplierName, concept, totalUsd, dueDate, note, sourceOrderId }) {
  return {
    id: crypto.randomUUID(),
    supplierName: (supplierName || '').trim() || 'Proveedor',
    concept: (concept || '').trim(),
    date: new Date().toISOString().slice(0, 10),
    dueDate: dueDate || null, // fecha limite de pago (YYYY-MM-DD) o null
    totalUsd: roundMoney(Math.max(0, Number(totalUsd || 0))),
    note: note || '',
    sourceOrderId: sourceOrderId || null, // orden de galpon que la origino (si aplica)
    payments: [],
    status: 'open',
    createdAt: new Date().toISOString()
  };
}

export function paidAmount(payable) {
  return roundMoney((payable.payments || []).reduce((sum, p) => sum + Number(p.amountUsd || 0), 0));
}

export function payableBalance(payable) {
  return roundMoney(payable.totalUsd - paidAmount(payable));
}

export function addPago(payable, { amountUsd, methodName, note }) {
  const amount = roundMoney(Math.max(0, Number(amountUsd || 0)));
  const payment = {
    id: crypto.randomUUID(),
    amountUsd: amount,
    methodName: methodName || '',
    note: note || '',
    createdAt: new Date().toISOString()
  };
  const payments = [...(payable.payments || []), payment];
  const paid = payments.reduce((sum, p) => sum + p.amountUsd, 0);
  const status = paid >= payable.totalUsd - 0.001 ? 'paid' : 'partial';
  return { payable: { ...payable, payments, status }, payment };
}

// Vencida = tiene fecha limite, ya paso y todavia se debe.
export function isOverdue(payable, today = new Date().toISOString().slice(0, 10)) {
  return payable.status !== 'paid' && Boolean(payable.dueDate) && payable.dueDate < today;
}

export function payablesSummary(payables, today = new Date().toISOString().slice(0, 10)) {
  const totalUsd = roundMoney(payables.reduce((sum, p) => sum + Number(p.totalUsd || 0), 0));
  const paidUsd = roundMoney(payables.reduce((sum, p) => sum + paidAmount(p), 0));
  const overdue = payables.filter((p) => isOverdue(p, today));
  return {
    totalUsd,
    paidUsd,
    balanceUsd: roundMoney(totalUsd - paidUsd),
    overdueUsd: roundMoney(overdue.reduce((sum, p) => sum + payableBalance(p), 0)),
    overdueCount: overdue.length,
    openCount: payables.filter((p) => p.status !== 'paid').length,
    totalCount: payables.length
  };
}
