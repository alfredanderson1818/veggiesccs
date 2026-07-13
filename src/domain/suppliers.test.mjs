import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSupplierKey, findSupplierMatch, createSupplier } from './suppliers.mjs';

const registry = [
  { id: 'sup-1', name: 'Importadora Zonatov 18' },
  { id: 'sup-2', name: 'Galpon Principal' },
  { id: 'sup-3', name: 'Frutas del Sur' }
];

test('normalizes names (accents, symbols, spacing, case)', () => {
  assert.equal(normalizeSupplierKey('  Galpón   PRINCIPAL. '), 'galpon principal');
  assert.equal(normalizeSupplierKey('Importadora Zonatov 18, C.A.'), 'importadora zonatov 18 c a');
});

test('matches exact normalized name', () => {
  assert.equal(findSupplierMatch(registry, 'galpón principal')?.id, 'sup-2');
});

test('matches by containment ("algo parecido")', () => {
  assert.equal(findSupplierMatch(registry, 'zonatov')?.id, 'sup-1');
  assert.equal(findSupplierMatch(registry, 'Importadora Zonatov 18 C.A.')?.id, 'sup-1');
});

test('matches typos via similarity', () => {
  assert.equal(findSupplierMatch(registry, 'galpon prinsipal')?.id, 'sup-2');
});

test('does not match unrelated names', () => {
  assert.equal(findSupplierMatch(registry, 'Distribuidora Centro'), null);
  assert.equal(findSupplierMatch(registry, ''), null);
  assert.equal(findSupplierMatch([], 'zonatov'), null);
});

test('creates supplier with trimmed name', () => {
  const s = createSupplier({ name: '  Nuevo Prov  ' });
  assert.equal(s.name, 'Nuevo Prov');
  assert.ok(s.id.startsWith('sup-'));
});
