import { roundMoney } from './money.mjs';
import { normalizeUnit } from './invoiceImport.mjs';

// Convierte el resultado estructurado de la IA (edge function leer-factura)
// en los renglones que espera la pre-factura y en un encabezado normalizado.

// El costo real por unidad es el precio impreso menos el descuento global.
export function netUnitCost(precioUnitario, descuentoPct) {
  const pct = Number(descuentoPct || 0);
  const gross = Number(precioUnitario || 0);
  return roundMoney(gross * (1 - pct / 100));
}

// Renglones IA -> items del formato del parser (los consume buildPreInvoiceRows).
export function aiItemsToParserItems(invoice) {
  const items = Array.isArray(invoice?.items) ? invoice.items : [];
  const pct = invoice?.descuentoPct;
  return items
    .filter((item) => item && String(item.descripcion || '').trim())
    .map((item) => ({
      description: String(item.descripcion).trim(),
      unit: normalizeUnit(item.unidad || '') || 'Und',
      quantity: roundMoney(Math.max(0, Number(item.cantidad || 0))),
      unitCostUsd: netUnitCost(item.precioUnitario, pct),
      codigo: item.codigo || null
    }));
}

// Encabezado normalizado para el sistema (proveedor, credito, vencimiento...).
export function aiInvoiceMeta(invoice) {
  if (!invoice || typeof invoice !== 'object') return null;
  const tipoPago = String(invoice.tipoPago || '').toUpperCase();
  const isCredit = tipoPago.includes('CRED');
  return {
    proveedor: (invoice.proveedor || '').trim() || null,
    numero: (invoice.numeroDocumento || '').trim() || null,
    fecha: normalizeDate(invoice.fecha),
    vencimiento: normalizeDate(invoice.vencimiento),
    tipoPago: tipoPago || null,
    isCredit,
    descuentoPct: Number(invoice.descuentoPct || 0) || 0,
    totalPagar: roundMoney(Number(invoice.totalPagar || 0)) || null,
    observaciones: (invoice.observaciones || '').trim() || null
  };
}

// Acepta YYYY-MM-DD (ideal) o DD/MM/YYYY (por si la IA copia el formato impreso).
export function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dmy = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}
