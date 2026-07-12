import { products, paymentMethods, accounts, defaultSettings, customers } from '../data/seed.mjs';
import { loadValue, saveValue } from './storage.mjs';

// Claves del estado que se persisten y sincronizan (fuente unica de verdad).
export const STATE_KEYS = [
  'products',
  'customers',
  'paymentMethods',
  'accounts',
  'accountMovements',
  'inventoryMovements',
  'documents',
  'returns',
  'receivables',
  'payables',
  'rateHistory',
  'rateAudit',
  'settings',
  'orders',
  'supplierOrders'
];

// Snapshot serializable del estado (para subir a la nube).
export function serializeState(state) {
  const out = {};
  STATE_KEYS.forEach((key) => {
    out[key] = state[key];
  });
  return out;
}

// Vuelca un snapshot remoto sobre el estado en memoria (mutacion in-place;
// `state` es const en main.mjs, por eso no se reasigna, se mutan sus claves).
export function hydrateState(state, data) {
  if (!data || typeof data !== 'object') return state;
  STATE_KEYS.forEach((key) => {
    if (data[key] !== undefined) state[key] = data[key];
  });
  return state;
}

export function loadInitialState() {
  return {
    products: loadValue('products', products),
    customers: loadValue('customers', customers),
    paymentMethods: loadValue('paymentMethods', paymentMethods),
    accounts: loadValue('accounts', accounts),
    accountMovements: loadValue('accountMovements', []),
    inventoryMovements: loadValue('inventoryMovements', []),
    documents: loadValue('documents', []),
    returns: loadValue('returns', []),
    receivables: loadValue('receivables', []),
    payables: loadValue('payables', []),
    rateHistory: loadValue('rateHistory', [
      { ...defaultSettings.exchangeRate, source: 'BCV', fetchedAt: new Date().toISOString() }
    ]),
    rateAudit: loadValue('rateAudit', []),
    settings: loadValue('settings', defaultSettings),
    orders: loadValue('orders', []),
    supplierOrders: loadValue('supplierOrders', [])
  };
}

export function persistState(state) {
  saveValue('products', state.products);
  saveValue('customers', state.customers);
  saveValue('paymentMethods', state.paymentMethods);
  saveValue('accounts', state.accounts);
  saveValue('accountMovements', state.accountMovements);
  saveValue('inventoryMovements', state.inventoryMovements);
  saveValue('documents', state.documents);
  saveValue('returns', state.returns);
  saveValue('receivables', state.receivables);
  saveValue('payables', state.payables);
  saveValue('rateHistory', state.rateHistory);
  saveValue('rateAudit', state.rateAudit);
  saveValue('settings', state.settings);
  saveValue('orders', state.orders);
  saveValue('supplierOrders', state.supplierOrders);
}
