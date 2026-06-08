import { roundMoney } from './money.mjs';

// Fase 9 (Venezuela Pro): motor de tasa de cambio.
// Historial diario, auditoria de cambios, diferencia BCV vs cobrada y redondeo de Bs.

export function recordRate(history, entry) {
  const date = entry.date;
  const source = entry.source || 'manual';
  const value = roundMoney(Number(entry.value));
  const filtered = (history || []).filter((rate) => !(rate.date === date && rate.source === source));
  const next = [
    { date, value, source, fetchedAt: entry.fetchedAt ?? new Date().toISOString() },
    ...filtered
  ];
  return next.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function latestRate(history, source) {
  const list = source ? (history || []).filter((rate) => rate.source === source) : history || [];
  return list.length ? list[0] : null;
}

export function createRateAuditEntry({ fromValue, toValue, source, reason, orderNumber }) {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    fromValue: roundMoney(Number(fromValue || 0)),
    toValue: roundMoney(Number(toValue || 0)),
    source: source || 'manual',
    reason: (reason || '').trim(),
    orderNumber: orderNumber ?? null
  };
}

export function rateChanged(prevValue, nextValue) {
  return roundMoney(Number(prevValue || 0)) !== roundMoney(Number(nextValue || 0));
}

export function rateDifference(chargedValue, referenceValue) {
  const charged = Number(chargedValue || 0);
  const reference = Number(referenceValue || 0);
  if (!reference) return { diffBs: 0, percent: 0 };
  return {
    diffBs: roundMoney(charged - reference),
    percent: roundMoney(((charged - reference) / reference) * 100)
  };
}

export function applyBsRounding(amountVes, rounding) {
  const amount = Number(amountVes || 0);
  const step = Number(rounding?.step || 0);
  if (!step) return roundMoney(amount);
  const mode = rounding?.mode || 'nearest';
  const n = amount / step;
  const rounded = mode === 'up' ? Math.ceil(n) : mode === 'down' ? Math.floor(n) : Math.round(n);
  return roundMoney(rounded * step);
}
