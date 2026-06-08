import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPaymentMovement,
  createTransferMovements,
  createAdjustmentMovement,
  createAccount,
  createPaymentMethod,
  convertAmount,
  applyMovements,
  totalsByCurrency
} from './accounts.mjs';

const accounts = [
  { id: 'acc-usd', name: 'Caja USD', currency: 'USD', balance: 10 },
  { id: 'acc-ves', name: 'Bancamiga', currency: 'VES', balance: 1000 }
];

test('adds paid order amount to the matching account', () => {
  const movement = createPaymentMovement({
    accountId: 'acc-usd',
    orderId: 'order-1',
    orderNumber: 601,
    amount: 15.4,
    currency: 'USD',
    methodName: 'Efectivo $'
  });

  const updated = applyMovements(accounts, [movement]);

  assert.equal(updated.find((account) => account.id === 'acc-usd').balance, 25.4);
});

test('creates paired transfer movements in the same currency', () => {
  const usdA = { id: 'acc-usd', name: 'Caja USD', currency: 'USD' };
  const usdB = { id: 'acc-binance', name: 'Binance', currency: 'USD' };
  const movements = createTransferMovements({ fromAccount: usdA, toAccount: usdB, amount: 5 });

  assert.equal(movements.length, 2);
  assert.equal(movements[0].amount, -5);
  assert.equal(movements[1].amount, 5);
  assert.equal(movements[0].transferId, movements[1].transferId);
});

test('cross-currency transfer converts USD to VES with the chosen rate', () => {
  const usd = { id: 'acc-usd', name: 'Caja USD', currency: 'USD' };
  const ves = { id: 'acc-ves', name: 'Bancamiga', currency: 'VES' };
  const movements = createTransferMovements({ fromAccount: usd, toAccount: ves, amount: 10, rate: 567.68 });

  assert.equal(movements[0].amount, -10); // sale USD
  assert.equal(movements[0].currency, 'USD');
  assert.equal(movements[1].amount, 5676.8); // entra Bs
  assert.equal(movements[1].currency, 'VES');
  assert.match(movements[0].note, /567\.68 Bs\/\$/);
});

test('cross-currency transfer converts VES to USD dividing by the rate', () => {
  const ves = { id: 'acc-ves', name: 'Caja Bs', currency: 'VES' };
  const usd = { id: 'acc-usd', name: 'Zelle', currency: 'USD' };
  const movements = createTransferMovements({ fromAccount: ves, toAccount: usd, amount: 5676.8, rate: 567.68 });
  assert.equal(movements[0].amount, -5676.8);
  assert.equal(movements[1].amount, 10);
});

test('convertAmount handles both directions and same currency', () => {
  assert.equal(convertAmount(10, 'USD', 'VES', 100), 1000);
  assert.equal(convertAmount(1000, 'VES', 'USD', 100), 10);
  assert.equal(convertAmount(10, 'USD', 'USD', 100), 10);
});

test('creates new account and payment method linked to it', () => {
  const account = createAccount({ name: '  Mercantil  ', currency: 'VES', balance: 250 });
  assert.equal(account.name, 'Mercantil');
  assert.equal(account.currency, 'VES');
  assert.equal(account.balance, 250);
  assert.ok(account.id.startsWith('acc-'));

  const method = createPaymentMethod({ name: 'Pago Movil Mercantil', account });
  assert.equal(method.accountId, account.id);
  assert.equal(method.currency, 'VES');
  assert.equal(method.accountName, 'Mercantil');
});

test('manual withdrawal reduces account balance', () => {
  const movement = createAdjustmentMovement({
    accountId: 'acc-ves',
    amount: -200,
    currency: 'VES',
    note: 'Retiro caja chica'
  });

  const updated = applyMovements(accounts, [movement]);

  assert.equal(updated.find((account) => account.id === 'acc-ves').balance, 800);
});

test('summarizes balances by currency', () => {
  const totals = totalsByCurrency(accounts);

  assert.equal(totals.USD, 10);
  assert.equal(totals.VES, 1000);
});

