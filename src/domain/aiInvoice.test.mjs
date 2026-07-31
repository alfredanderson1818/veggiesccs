import test from 'node:test';
import assert from 'node:assert/strict';
import { netUnitCost, aiItemsToParserItems, aiInvoiceMeta, normalizeDate } from './aiInvoice.mjs';

// Respuesta real que devolveria la IA para la nota A0008550 de Zonatov (recortada).
const zonatov = {
  proveedor: 'IMPORTADORA ZONATOV 18, C.A.',
  numeroDocumento: 'A0008550',
  fecha: '2026-07-13',
  vencimiento: '2026-08-03',
  tipoPago: 'CREDITO',
  items: [
    { codigo: '650042', descripcion: 'PINTURA SPRAY ALUMINIO 400ML', cantidad: 12, unidad: 'UND', precioUnitario: 2, total: 24 },
    { codigo: '650064', descripcion: 'SPRAY REFLECTANTE NOCTURNO 450ML', cantidad: 12, unidad: null, precioUnitario: 5.5, total: 66 },
    { codigo: '650000', descripcion: 'EXHIBIDOR DE SPRAY', cantidad: 1, unidad: 'UND', precioUnitario: 0, total: 0 }
  ],
  descuentoPct: 20,
  subtotal: 491.52,
  totalPagar: 491.52,
  observaciones: null
};

test('net unit cost applies the global discount', () => {
  assert.equal(netUnitCost(2, 20), 1.6);
  assert.equal(netUnitCost(5.5, 20), 4.4);
  assert.equal(netUnitCost(3, null), 3);
  assert.equal(netUnitCost(0, 20), 0);
});

test('maps AI items to parser items with discounted costs', () => {
  const items = aiItemsToParserItems(zonatov);
  assert.equal(items.length, 3);
  assert.equal(items[0].description, 'PINTURA SPRAY ALUMINIO 400ML');
  assert.equal(items[0].unitCostUsd, 1.6); // 2.00 - 20%
  assert.equal(items[0].quantity, 12);
  assert.equal(items[1].unitCostUsd, 4.4); // 5.50 - 20%
  assert.equal(items[1].unit, 'Und'); // unidad null -> Und por defecto
  assert.equal(items[2].unitCostUsd, 0);
});

test('extracts normalized meta with credit detection', () => {
  const meta = aiInvoiceMeta(zonatov);
  assert.equal(meta.proveedor, 'IMPORTADORA ZONATOV 18, C.A.');
  assert.equal(meta.isCredit, true);
  assert.equal(meta.vencimiento, '2026-08-03');
  assert.equal(meta.totalPagar, 491.52);
  assert.equal(meta.descuentoPct, 20);
});

test('contado invoices are not credit', () => {
  const meta = aiInvoiceMeta({ ...zonatov, tipoPago: 'CONTADO', vencimiento: null });
  assert.equal(meta.isCredit, false);
  assert.equal(meta.vencimiento, null);
});

test('normalizes venezuelan date formats', () => {
  assert.equal(normalizeDate('2026-08-03'), '2026-08-03');
  assert.equal(normalizeDate('03/08/2026'), '2026-08-03');
  assert.equal(normalizeDate('3/8/2026'), '2026-08-03');
  assert.equal(normalizeDate(''), null);
  assert.equal(normalizeDate('sin fecha'), null);
});

test('handles empty or malformed AI responses', () => {
  assert.deepEqual(aiItemsToParserItems(null), []);
  assert.deepEqual(aiItemsToParserItems({ items: [{ descripcion: '  ' }] }), []);
  assert.equal(aiInvoiceMeta(null), null);
});
