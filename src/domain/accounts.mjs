import { roundMoney } from './money.mjs';

export function createPaymentMovement({ accountId, orderId, orderNumber, amount, currency, methodName }) {
  return {
    id: crypto.randomUUID(),
    accountId,
    type: 'payment',
    amount: roundMoney(amount),
    currency,
    note: `Pedido #${orderNumber} · ${methodName}`,
    orderId,
    createdAt: new Date().toISOString()
  };
}

// Convierte el monto a la moneda de la cuenta destino usando la tasa indicada.
// USD -> VES multiplica por la tasa; VES -> USD divide entre la tasa.
export function convertAmount(amount, fromCurrency, toCurrency, rate) {
  const value = roundMoney(amount);
  if (fromCurrency === toCurrency) return value;
  if (fromCurrency === 'USD' && toCurrency === 'VES') return roundMoney(value * Number(rate || 0));
  if (fromCurrency === 'VES' && toCurrency === 'USD') return rate ? roundMoney(value / Number(rate)) : 0;
  return value;
}

export function createTransferMovements({ fromAccount, toAccount, amount, rate, note }) {
  const transferId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const out = roundMoney(amount);
  const received = convertAmount(out, fromAccount.currency, toAccount.currency, rate);
  const crossCurrency = fromAccount.currency !== toAccount.currency;
  const rateNote = crossCurrency && rate ? ` @ ${rate} Bs/$` : '';
  const finalNote = note?.trim() || `Transferencia ${fromAccount.name} -> ${toAccount.name}${rateNote}`;

  return [
    {
      id: crypto.randomUUID(),
      transferId,
      accountId: fromAccount.id,
      type: 'transfer_out',
      amount: -out,
      currency: fromAccount.currency,
      rate: crossCurrency ? Number(rate) : null,
      note: finalNote,
      createdAt
    },
    {
      id: crypto.randomUUID(),
      transferId,
      accountId: toAccount.id,
      type: 'transfer_in',
      amount: received,
      currency: toAccount.currency,
      rate: crossCurrency ? Number(rate) : null,
      note: finalNote,
      createdAt
    }
  ];
}

export function createAccount({ name, currency, balance = 0 }) {
  return {
    id: `acc-${crypto.randomUUID().slice(0, 8)}`,
    name: (name || '').trim() || 'Cuenta',
    currency: currency === 'VES' ? 'VES' : 'USD',
    balance: roundMoney(Number(balance || 0))
  };
}

export function createPaymentMethod({ name, account }) {
  return {
    id: `pm-${crypto.randomUUID().slice(0, 8)}`,
    name: (name || '').trim() || 'Metodo',
    accountName: account.name,
    currency: account.currency,
    accountId: account.id
  };
}

export function createAdjustmentMovement({ accountId, amount, currency, note }) {
  return {
    id: crypto.randomUUID(),
    accountId,
    type: amount >= 0 ? 'income' : 'withdrawal',
    amount: roundMoney(amount),
    currency,
    note,
    createdAt: new Date().toISOString()
  };
}

export function applyMovements(accounts, movements) {
  return accounts.map((account) => {
    const delta = movements
      .filter((movement) => movement.accountId === account.id)
      .reduce((sum, movement) => sum + movement.amount, 0);
    return { ...account, balance: roundMoney(Number(account.balance || 0) + delta) };
  });
}

export function totalsByCurrency(accounts) {
  return accounts.reduce((totals, account) => {
    totals[account.currency] = roundMoney((totals[account.currency] || 0) + Number(account.balance || 0));
    return totals;
  }, {});
}

