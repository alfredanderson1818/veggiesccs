import { products, paymentMethods, accounts, defaultSettings, customers } from '../data/seed.mjs';
import { loadValue, saveValue } from './storage.mjs';

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
  saveValue('rateHistory', state.rateHistory);
  saveValue('rateAudit', state.rateAudit);
  saveValue('settings', state.settings);
  saveValue('orders', state.orders);
  saveValue('supplierOrders', state.supplierOrders);
}
