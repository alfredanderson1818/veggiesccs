import { products as catalogProducts } from './products.mjs';

export { customers } from './customers.mjs';

export const suppliers = [
  { id: 'sup-galpon', name: 'Galpon Principal', phone: '', location: 'Mercado Mayorista' },
  { id: 'sup-dist', name: 'Distribuidora Centro', phone: '', location: 'Caracas' }
];

// Catalogo real del cliente (133 productos) + el servicio de despacho.
export const products = [
  ...catalogProducts,
  {
    id: 'p-flete',
    sku: 'SRV001',
    name: 'Servicio de despacho',
    unit: 'Servicio',
    priceUsd: 5,
    prices: { Principal: 5, Mayor: 5 },
    estimatedCostUsd: 2,
    controlMode: 'service',
    stock: null,
    supplierId: '',
    supplierName: '',
    category: 'Servicios'
  }
];

export const paymentMethods = [
  { id: 'pago-movil', name: 'Pago Movil', accountName: 'Bancamiga Veggies', currency: 'VES', accountId: 'acc-bancamiga' },
  { id: 'zelle', name: 'Zelle', accountName: 'Zelle AVI', currency: 'USD', accountId: 'acc-zelle' },
  { id: 'efectivo-usd', name: 'Efectivo $', accountName: 'Caja USD', currency: 'USD', accountId: 'acc-caja-usd' },
  { id: 'efectivo-ves', name: 'Efectivo Bs', accountName: 'Caja Bs', currency: 'VES', accountId: 'acc-caja-ves' },
  { id: 'binance', name: 'Binance USDT', accountName: 'Binance', currency: 'USD', accountId: 'acc-binance' },
  { id: 'combinado', name: 'Pago Combinado', accountName: 'Multiple', currency: 'MIXED', accountId: 'acc-caja-usd' }
];

export const accounts = [
  { id: 'acc-binance', name: 'Binance', currency: 'USD', balance: 47.59 },
  { id: 'acc-zelle', name: 'Zelle AVI', currency: 'USD', balance: 244.01 },
  { id: 'acc-caja-usd', name: 'Efectivo $', currency: 'USD', balance: 150.78 },
  { id: 'acc-bancamiga', name: 'Bancamiga Veggies', currency: 'VES', balance: 1637.92 },
  { id: 'acc-caja-ves', name: 'Caja Bs', currency: 'VES', balance: 0 }
];

export const defaultSettings = {
  companyName: 'Veggies CCS',
  userName: 'Adam',
  exchangeRate: { value: 567.68, source: 'manual', date: '2026-06-08' },
  bsRounding: { step: 0, mode: 'nearest' },
  channel: 'Mayor',
  location: 'Todas',
  currencyView: 'USD'
};
