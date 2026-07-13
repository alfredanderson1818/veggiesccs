import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneVE, fillTemplate, waLink } from './messaging.mjs';

test('normalizes venezuelan phones to 58XXXXXXXXXX', () => {
  assert.equal(normalizePhoneVE('04129190459'), '584129190459');
  assert.equal(normalizePhoneVE('0412-919.04 59'), '584129190459');
  assert.equal(normalizePhoneVE('+58 424 2244622'), '584242244622');
  assert.equal(normalizePhoneVE('584242244622'), '584242244622');
  assert.equal(normalizePhoneVE('4242244622'), '584242244622');
});

test('rejects invalid phones', () => {
  assert.equal(normalizePhoneVE(''), null);
  assert.equal(normalizePhoneVE(null), null);
  assert.equal(normalizePhoneVE('123'), null);
  assert.equal(normalizePhoneVE('02129190459'), null); // fijo (no movil 04xx)
  assert.equal(normalizePhoneVE('12345678901234'), null);
});

test('fills template variables and drops missing ones', () => {
  const out = fillTemplate('Hola {nombre}, debes {saldo}{vencidoTxt}.', {
    nombre: 'Ana',
    saldo: '$12.00'
  });
  assert.equal(out, 'Hola Ana, debes $12.00.');
  assert.equal(fillTemplate('{a} y {b}', { a: 1, b: 'dos' }), '1 y dos');
  assert.equal(fillTemplate(null, {}), '');
});

test('builds wa.me link with encoded text', () => {
  const link = waLink('0412 919 0459', 'Hola Ana ¿como estas?');
  assert.ok(link.startsWith('https://wa.me/584129190459?text='));
  assert.ok(link.includes(encodeURIComponent('¿como estas?')));
  assert.equal(waLink('123', 'x'), null);
});
