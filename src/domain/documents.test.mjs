import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCUMENT_TYPES, nextDocumentNumber, createDocument } from './documents.mjs';

const order = {
  id: 'o-1',
  orderNumber: 581,
  date: '2026-06-08',
  customerName: '  Ana  ',
  exchangeRate: { value: 567.68 },
  items: [
    { sku: 'VC002', name: 'Aguacate', unit: 'Kg', quantity: 3, priceUsd: 4.5, estimatedCostUsd: 3.35, controlMode: 'on_demand' }
  ],
  totals: { subtotalUsd: 13.5, totalUsd: 13.5, totalVes: 7663.68, estimatedMarginUsd: 3.45 },
  payment: { methodName: 'Zelle', amountUsd: 13.5 }
};

test('generates correlative numbers per document type', () => {
  let docs = [];
  assert.equal(nextDocumentNumber(docs, 'factura'), 'FAC-0001');
  docs = [{ type: 'factura' }];
  assert.equal(nextDocumentNumber(docs, 'factura'), 'FAC-0002');
  // distinct counter per type
  assert.equal(nextDocumentNumber(docs, 'cotizacion'), 'COT-0001');
});

test('throws for invalid document type', () => {
  assert.throws(() => nextDocumentNumber([], 'inexistente'));
  assert.throws(() => createDocument({ order, type: 'inexistente', number: 'X' }));
});

test('creates a document snapshot from an order', () => {
  const doc = createDocument({ order, type: 'factura', number: 'FAC-0001', issuedAt: '2026-06-08T10:00:00.000Z' });
  assert.equal(doc.type, 'factura');
  assert.equal(doc.label, DOCUMENT_TYPES.factura.label);
  assert.equal(doc.number, 'FAC-0001');
  assert.equal(doc.customerName, 'Ana');
  assert.equal(doc.orderNumber, 581);
  assert.equal(doc.items[0].totalUsd, 13.5);
  assert.equal(doc.exchangeRate, 567.68);
});

test('falls back to Mostrador when no customer name', () => {
  const doc = createDocument({ order: { ...order, customerName: '' }, type: 'recibo', number: 'REC-0001' });
  assert.equal(doc.customerName, 'Mostrador');
});
