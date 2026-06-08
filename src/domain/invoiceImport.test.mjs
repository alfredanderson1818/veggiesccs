import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInvoiceLine,
  parseInvoiceText,
  normalizeUnit,
  suggestSalePrice,
  matchProduct,
  matchScore,
  cleanForMatch,
  buildPreInvoiceRows,
  preInvoiceTotals
} from './invoiceImport.mjs';

const catalog = [
  { id: 'p-aguacate', name: 'Aguacate', sku: 'VC002', priceUsd: 4.8, prices: { Principal: 4.8, Mayor: 4.5 }, estimatedCostUsd: 3, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-cebolla-morada', name: 'Cebolla Morada', sku: 'VC030', priceUsd: 1.8, prices: { Principal: 1.8, Mayor: 1.6 }, estimatedCostUsd: 1.2, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-cebolla-blanca', name: 'Cebolla Blanca', sku: 'VC031', priceUsd: 1.5, estimatedCostUsd: 1, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-melon', name: 'Melon', sku: 'VC070', priceUsd: 1.5, estimatedCostUsd: 1, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-brocoli', name: 'Brocoli', sku: 'VC040', priceUsd: 1.5, estimatedCostUsd: 1, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-pimenton', name: 'Pimenton', sku: 'VC080', priceUsd: 3.75, estimatedCostUsd: 2.5, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-cilantro', name: 'Cilantro', sku: 'VC050', priceUsd: 3.8, estimatedCostUsd: 2.8, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-tomate', name: 'Tomate', sku: 'VC106', priceUsd: 2.73, estimatedCostUsd: 2, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-mandarina', name: 'Mandarina', sku: 'VC060', priceUsd: 3.67, estimatedCostUsd: 2.5, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-lechuga-americana', name: 'Lechuga Americana', sku: 'VC065', priceUsd: 1, estimatedCostUsd: 0.7, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-repollo-blanco', name: 'Repollo Blanco', sku: 'VC090', priceUsd: 0.83, estimatedCostUsd: 0.5, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-aji-dulce', name: 'Aji Dulce', sku: 'VC005', priceUsd: 3, estimatedCostUsd: 2, controlMode: 'on_demand', unit: 'Kg' },
  { id: 'p-flete', name: 'Servicio de despacho', sku: 'SRV001', priceUsd: 5, controlMode: 'service', unit: 'Servicio' }
];

const sample = `Nota de Entrega Nro: 0000137302
NOMBRE DE CLIENTE: ADAN MANIR
R.I.F.: 21414808
COND.PAGO: CONTADO
DESCRIPCION UNI CANT P/UNI TOTAL
ZANAHORIA KG 1,50 1,19 1,79
CALABACIN KG 1,70 0,70 1,19
PAPA LAVADA UNI 1,80 1,95 3,51
AGUACATE KG 1,50 4,00 6,00
MANZANA VERDE #80 UNI 4,00 0,95 3,80
AJO EN CONCHA IMPORTADO KG 0,30 5,40 1,62
Ttl: 32,00
TOTAL USD 50,00`;

test('parses a single line with comma decimals', () => {
  const item = parseInvoiceLine('ZANAHORIA KG 1,50 1,19 1,79');
  assert.equal(item.description, 'ZANAHORIA');
  assert.equal(item.unit, 'Kg');
  assert.equal(item.quantity, 1.5);
  assert.equal(item.unitCostUsd, 1.19);
  assert.equal(item.totalUsd, 1.79);
});

test('keeps size codes in description and uses numbers after the unit', () => {
  const item = parseInvoiceLine('MANZANA VERDE #80 UNI 4,00 0,95 3,80');
  assert.equal(item.description, 'MANZANA VERDE #80');
  assert.equal(item.unit, 'Und');
  assert.equal(item.quantity, 4);
  assert.equal(item.unitCostUsd, 0.95);
  assert.equal(item.totalUsd, 3.8);
});

test('skips headers, totals and non-item lines', () => {
  assert.equal(parseInvoiceLine('DESCRIPCION UNI CANT P/UNI TOTAL'), null);
  assert.equal(parseInvoiceLine('COND.PAGO: CONTADO'), null);
  assert.equal(parseInvoiceLine('TOTAL USD 50,00'), null);
  assert.equal(parseInvoiceLine('Ttl: 32,00'), null);
});

test('parses the full receipt block into items only', () => {
  const items = parseInvoiceText(sample);
  assert.equal(items.length, 6);
  assert.equal(items[3].description, 'AGUACATE');
  assert.equal(items[3].totalUsd, 6);
});

test('merges two-line layout (name above, numbers below) preserving order', () => {
  // Tal como el OCR parte la foto: descripcion en una linea, UNI/CANT/P/UNI/TOTAL en la siguiente
  const twoLine = `Nota de Entrega Nro: 0000137302
DESCRIPCION UNI CANT P/UNI TOTAL
ZANAHORIA
KG 1,50 1,19 1,79
CALABACIN
KG 1,70 0,70 1,19
APIO
KG 1,00 1,13 1,13
APIO ESPAÑA KG
KG 0,80 1,00 0,80
Ttl: 32,00
TOTAL USD 50,00`;
  const items = parseInvoiceText(twoLine);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.description), ['ZANAHORIA', 'CALABACIN', 'APIO', 'APIO ESPAÑA KG']);
  assert.equal(items[0].quantity, 1.5);
  assert.equal(items[0].unitCostUsd, 1.19);
  assert.equal(items[3].unit, 'Kg');
});

test('captures most rows from REAL messy Tesseract output (garbled KG units)', () => {
  const realOcr = [
    'RIF 21414813 origen: PCLI 4: 0000061791',
    '| 1 == RIZCION “UNI CANT PUN! TOTAL',
    'ZANA dci _ a. a 1560 119 1,79 Ln',
    'CALA 3ACIN E 0,70 1,19 Za',
    'OcuNO BLANCO n 0,80 150 1,20 e Be',
    'PEPINO KG 140 0,70 0,98 ue',
    'AGUA CATE KG 150 400 600 e',
    'CEBCLLA BLANCA ke 12 150 180',
    'PIÑA UN 1,00 200 200',
    '7 MELCN KG 210 160 + 9,16',
    'AJO EN ZONCHA KG 0,30 50 1,62',
    'Tt: 32,00 TOTAL USD 50,00'
  ].join('\n');
  const items = parseInvoiceText(realOcr);
  // captura aunque la unidad venga destrozada ("ke", "n", o ausente)
  assert.ok(items.length >= 9, `esperaba >= 9, fueron ${items.length}`);
  const cebolla = items.find((i) => /CEBCLLA BLANCA/i.test(i.description));
  assert.ok(cebolla, 'no capturo CEBCLLA BLANCA (KG leido como "ke")');
  assert.equal(cebolla.unit, 'Kg'); // unidad inferida
  assert.ok(items.some((i) => /AGUA CATE/i.test(i.description)));
});

test('handles mixed single-line and two-line rows in order', () => {
  const mixed = `ZANAHORIA KG 1,50 1,19 1,79
CALABACIN
KG 1,70 0,70 1,19
AGUACATE KG 1,50 4,00 6,00`;
  const items = parseInvoiceText(mixed);
  assert.deepEqual(items.map((i) => i.description), ['ZANAHORIA', 'CALABACIN', 'AGUACATE']);
});

test('normalizes units', () => {
  assert.equal(normalizeUnit('KG'), 'Kg');
  assert.equal(normalizeUnit('UNI'), 'Und');
  assert.equal(normalizeUnit('UND'), 'Und');
});

test('suggests sale price from cost and margin', () => {
  assert.equal(suggestSalePrice(1, 30), 1.3);
  assert.equal(suggestSalePrice(4, 25), 5);
});

test('matches catalog products by name ignoring accents/case', () => {
  const products = [
    { id: 'p-aguacate', name: 'Aguacate', priceUsd: 4.5, controlMode: 'on_demand', supplierName: 'Galpon Principal' },
    { id: 'p-apio', name: 'Apio Espana', priceUsd: 1.7, controlMode: 'on_demand' }
  ];
  assert.equal(matchProduct('AGUACATE', products).id, 'p-aguacate');
  assert.equal(matchProduct('apio españa', products).id, 'p-apio');
  assert.equal(matchProduct('NO EXISTE', products), null);
});

test('builds editable rows: matched uses catalog price, unmatched uses margin', () => {
  const products = [{ id: 'p-aguacate', name: 'Aguacate', priceUsd: 4.5, controlMode: 'on_demand', supplierName: 'Galpon Principal' }];
  const items = parseInvoiceText(sample);
  const rows = buildPreInvoiceRows(items, { marginPct: 30, products });
  const aguacate = rows.find((r) => r.productId === 'p-aguacate');
  assert.equal(aguacate.description, 'Aguacate'); // corrected to catalog name
  assert.equal(aguacate.priceUsd, 4.5); // catalog price
  assert.equal(aguacate.unitCostUsd, 4); // catalog has no cost -> falls back to invoice
  const zanahoria = rows.find((r) => r.description === 'ZANAHORIA');
  assert.equal(zanahoria.productId, null);
  assert.equal(zanahoria.priceUsd, suggestSalePrice(1.19, 30)); // 1.55
});

test('fuzzy-matches messy OCR descriptions to the catalog', () => {
  const cases = {
    'AGUA CATE': 'Aguacate',
    'CEBCLLA MORADA': 'Cebolla Morada',
    '7 MELCN': 'Melon',
    'A BROC OL': 'Brocoli',
    'E PIMENTN': 'Pimenton',
    'NE CILANTRO': 'Cilantro',
    'a i TOM TE': 'Tomate',
    'A MANE ¡ARINA': 'Mandarina',
    'LECHJCIA AMERICANA': 'Lechuga Americana',
    'REPCLLO BLANCO': 'Repollo Blanco',
    '| Ma AJ DULCE': 'Aji Dulce'
  };
  for (const [ocr, expected] of Object.entries(cases)) {
    const matched = matchProduct(ocr, catalog);
    assert.ok(matched, `no match para "${ocr}"`);
    assert.equal(matched.name, expected, `"${ocr}" deberia ser ${expected}, fue ${matched?.name}`);
  }
});

test('does not match unrelated text or services', () => {
  assert.equal(matchProduct('xyzqwk', catalog), null);
  assert.equal(matchProduct('flete despacho', catalog)?.controlMode, undefined); // service excluido
});

test('cleanForMatch strips OCR noise tokens and digits', () => {
  assert.equal(cleanForMatch('AGUA CATE'), 'aguacate');
  assert.equal(cleanForMatch('7 MELCN'), 'melcn');
  assert.equal(cleanForMatch('a i TOM TE'), 'tomte');
});

test('matched rows pull name, sku, cost and price from catalog', () => {
  const rows = buildPreInvoiceRows(parseInvoiceText('AGUA CATE KG 150,00 400,00 520,00'), { marginPct: 30, products: catalog });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.description, 'Aguacate'); // nombre corregido del catalogo
  assert.equal(r.sku, 'VC002');
  assert.equal(r.productId, 'p-aguacate');
  assert.equal(r.priceUsd, 4.8); // precio del catalogo, no el 520 del OCR
  assert.equal(r.unitCostUsd, 3); // costo del catalogo, no el 400 del OCR
  assert.equal(r.matched, true);
  assert.equal(r.quantity, 150); // cantidad si viene del documento
});

test('computes pre-invoice totals (cost, sale, margin)', () => {
  const rows = [
    { quantity: 2, unitCostUsd: 5, priceUsd: 7 },
    { quantity: 1, unitCostUsd: 3, priceUsd: 4 }
  ];
  const totals = preInvoiceTotals(rows);
  assert.equal(totals.costUsd, 13);
  assert.equal(totals.saleUsd, 18);
  assert.equal(totals.marginUsd, 5);
});
