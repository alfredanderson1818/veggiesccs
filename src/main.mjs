import {
  addItemToOrder,
  calculateOrderTotals,
  createOrderDraft,
  finalizeOrder,
  removeOrderItem,
  updateOrderItemQuantity
} from './domain/order.mjs';
import { formatUsd, formatVes, roundMoney } from './domain/money.mjs';
import {
  applyMovements,
  createPaymentMovement,
  totalsByCurrency,
  createTransferMovements,
  createAccount,
  createPaymentMethod,
  convertAmount
} from './domain/accounts.mjs';
import {
  advanceSupplierOrderStatus,
  calculateSupplierOrderMargin,
  createSupplierOrdersFromSale,
  updateSupplierOrderActuals
} from './domain/supplierOrder.mjs';
import {
  applyInventoryMovements,
  buildProductKardex,
  createInventoryAdjustment,
  createPurchaseMovement,
  createSaleMovementsFromSale,
  isInventoryProduct,
  lowStockProducts,
  summarizeInventory
} from './domain/inventory.mjs';
import {
  salesByDay,
  salesByMonth,
  salesByChannel,
  salesByPaymentMethod,
  topProducts,
  bestMarginProducts,
  frequentCustomers,
  profitSummary
} from './domain/reports.mjs';
import { DOCUMENT_TYPES, createDocument, nextDocumentNumber } from './domain/documents.mjs';
import { annulOrder } from './domain/returns.mjs';
import { createReceivable, addAbono, receivableBalance, paidAmount, receivablesSummary } from './domain/receivables.mjs';
import { createReturnMovements } from './domain/inventory.mjs';
import { createAdjustmentMovement } from './domain/accounts.mjs';
import {
  recordRate,
  latestRate,
  createRateAuditEntry,
  rateChanged,
  rateDifference,
  applyBsRounding
} from './domain/rates.mjs';
import {
  parseInvoiceText,
  suggestSalePrice,
  buildPreInvoiceRows,
  preInvoiceTotals
} from './domain/invoiceImport.mjs';
import { loadInitialState, persistState } from './state/appState.mjs';

const root = document.querySelector('#root');
const state = loadInitialState();
let activeView = 'pos';
let search = '';
let selectedPaymentMethod = state.paymentMethods[0].id;
let inventoryForm = { mode: 'purchase', productId: '', quantity: '', unitCostUsd: '', note: '' };
let bcvStatus = '';
let importState = { rawText: '', rows: [], status: '', marginPct: 30, busy: false };
let customerSearch = '';
let accountModal = null;
let customerQuery = '';
let paymentMode = 'contado'; // 'contado' | 'credito'
let currentOrder = createOrderDraft({
  orderNumber: nextOrderNumber(),
  exchangeRate: state.settings.exchangeRate,
  channel: state.settings.channel,
  location: state.settings.location
});

function nextOrderNumber() {
  return 580 + state.orders.length + 1;
}

function setState(mutator) {
  mutator();
  persistState(state);
  render();
}

function controlModeLabel(mode) {
  return {
    on_demand: 'Bajo pedido',
    inventory: 'Inventario',
    no_inventory: 'Sin inventario',
    service: 'Servicio'
  }[mode];
}

function filteredProducts() {
  const needle = search.trim().toLowerCase();
  const list = needle
    ? state.products.filter((product) =>
        `${product.sku} ${product.name} ${product.category}`.toLowerCase().includes(needle)
      )
    : state.products;
  return [...list].sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}

function productPrice(product, channel) {
  const prices = product.prices;
  if (prices) {
    return channel === 'Mayor' ? Number(prices.Mayor ?? product.priceUsd) : Number(prices.Principal ?? product.priceUsd);
  }
  return Number(product.priceUsd || 0);
}

function bcvRateValue() {
  return latestRate(state.rateHistory, 'BCV')?.value ?? null;
}

function chargedBs(usd) {
  return applyBsRounding(Number(usd || 0) * currentOrder.exchangeRate.value, state.settings.bsRounding);
}

function money(value) {
  return state.settings.currencyView === 'USD' ? formatUsd(value) : formatVes(chargedBs(value));
}

function dashboardMetrics() {
  const paidOrders = state.orders.filter((order) => order.status === 'paid');
  const sales = paidOrders.reduce((sum, order) => sum + order.totals.totalUsd, 0);
  const margin = paidOrders.reduce((sum, order) => sum + order.totals.estimatedMarginUsd, 0);
  return {
    sales,
    margin,
    count: paidOrders.length,
    average: paidOrders.length ? sales / paidOrders.length : 0
  };
}

const FOCUS_ATTRS = [
  'data-field',
  'data-row',
  'data-modal-field',
  'data-modal-select',
  'data-rate-field',
  'data-rounding-field',
  'data-import-margin',
  'data-item-qty',
  'data-supplier-qty',
  'data-supplier-cost',
  'data-customer-pick'
];

function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.matches || !el.matches('input, textarea, select')) return null;
  let selector = null;
  if (el.hasAttribute('data-import-text')) selector = '[data-import-text]';
  else {
    for (const attr of FOCUS_ATTRS) {
      if (el.hasAttribute(attr)) {
        selector = `[${attr}="${el.getAttribute(attr)}"]`;
        break;
      }
    }
  }
  if (!selector) return null;
  let start = null;
  let end = null;
  try {
    start = el.selectionStart;
    end = el.selectionEnd;
  } catch {
    /* number inputs no soportan selectionStart */
  }
  return { selector, start, end };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const el = document.querySelector(snapshot.selector);
  if (!el) return;
  el.focus();
  if (snapshot.start != null && el.setSelectionRange) {
    try {
      el.setSelectionRange(snapshot.start, snapshot.end);
    } catch {
      /* ignore */
    }
  }
}

function render() {
  const focusSnapshot = captureFocus();
  const totals = calculateOrderTotals(currentOrder);
  const metrics = dashboardMetrics();
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand-mark">
          <img src="src/assets/logo-veggies.png" alt="Veggies CCS" class="brand-logo" />
        </div>
        <p class="eyebrow">Modulos</p>
        ${navButton('dashboard', 'Home', 'Resumen')}
        ${navButton('pos', 'Pedidos', 'Nuevo pedido')}
        ${navButton('import', 'Importar', 'Factura proveedor')}
        ${navButton('galpon', 'Galpon', 'Preparacion')}
        ${navButton('catalog', 'Catalogo', 'Productos')}
        ${navButton('inventory', 'Inventario', 'Stock y kardex')}
        ${navButton('reports', 'Reportes', 'Ventas y utilidad')}
        ${navButton('rates', 'Tasa', 'BCV y redondeo')}
        ${navButton('documents', 'Documentos', 'Facturas y notas')}
        ${navButton('customers', 'Clientes', 'Cartera')}
        ${navButton('receivables', 'Creditos', 'Cuentas x cobrar')}
        ${navButton('accounts', 'Cuentas', 'Pagos')}
        <div class="sidebar-footer">
          <button class="ghost-button" data-action="reset-storage">Reiniciar demo</button>
          <small>Registrado como:<br><strong>${state.settings.userName}</strong></small>
        </div>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">Veggies CCS</p>
            <h1>${activeView === 'pos' ? 'Punto de venta' : 'Panel operativo'}</h1>
          </div>
          <div class="top-actions">
            <button class="primary-button" data-view="pos">Vender</button>
            <button class="ghost-button" data-view="import">Importar factura</button>
            <button class="coral-button" data-action="quick-expense">Agregar gasto</button>
          </div>
        </header>
        ${activeView === 'checkout' ? '' : renderDashboard(metrics)}
        ${activeView === 'dashboard' ? renderHome() : ''}
        ${activeView === 'checkout' ? renderCheckout(totals) : ''}
        ${activeView === 'pos' ? renderPos(totals) : ''}
        ${activeView === 'import' ? renderImport() : ''}
        ${activeView === 'galpon' ? renderGalpon() : ''}
        ${activeView === 'catalog' ? renderCatalog() : ''}
        ${activeView === 'inventory' ? renderInventory() : ''}
        ${activeView === 'reports' ? renderReports() : ''}
        ${activeView === 'rates' ? renderRates() : ''}
        ${activeView === 'documents' ? renderDocuments() : ''}
        ${activeView === 'customers' ? renderCustomers() : ''}
        ${activeView === 'receivables' ? renderReceivables() : ''}
        ${activeView === 'accounts' ? renderAccounts() : ''}
      </main>
    </div>
  `;
  bindEvents();
  restoreFocus(focusSnapshot);
}

function navButton(view, label, sublabel) {
  return `
    <button class="nav-button ${activeView === view ? 'active' : ''}" data-view="${view}">
      <span>${label}</span>
      <small>${sublabel}</small>
    </button>
  `;
}

function renderDashboard(metrics) {
  return `
    <section class="dashboard-grid">
      ${metricCard('Facturacion', formatUsd(metrics.sales), 'Ventas cerradas', 'solid')}
      ${metricCard('Ticket promedio', formatUsd(metrics.average), 'Por pedido', '')}
      ${metricCard('Ordenes', metrics.count, 'Finalizadas', '')}
      ${metricCard('Margen estimado', formatUsd(metrics.margin), 'Antes de costos reales', 'solid')}
    </section>
  `;
}

function renderVBars(items, { label, value, fmt }) {
  if (!items.length) return '<div class="chart-empty">Sin datos todavia</div>';
  const max = Math.max(...items.map((i) => Number(i[value]) || 0), 1);
  return `<div class="chart-bars">${items
    .map(
      (i) => `
        <div class="chart-bar" title="${i[label]}: ${fmt(i[value])}">
          <span class="bar-val">${fmt(i[value])}</span>
          <div class="bar-track"><div class="bar-fill" style="height:${Math.max(3, (Number(i[value]) / max) * 100)}%"></div></div>
          <span class="bar-label">${i[label]}</span>
        </div>`
    )
    .join('')}</div>`;
}

function renderHBars(items, { label, value, fmt }) {
  if (!items.length) return '<div class="chart-empty">Sin datos todavia</div>';
  const max = Math.max(...items.map((i) => Number(i[value]) || 0), 1);
  return `<div class="hbars">${items
    .map(
      (i) => `
        <div class="hbar">
          <span class="hbar-label">${i[label]}</span>
          <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(2, (Number(i[value]) / max) * 100)}%"></div></div>
          <span class="hbar-val">${fmt(i[value])}</span>
        </div>`
    )
    .join('')}</div>`;
}

function renderHome() {
  const orders = state.orders;
  const byDay = salesByDay(orders).slice(0, 7).reverse().map((d) => ({ ...d, dayLabel: d.date.slice(5) }));
  const top = topProducts(orders).slice(0, 6);
  const byMethod = salesByPaymentMethod(orders).slice(0, 6);
  const profit = profitSummary(orders, state.supplierOrders);
  const recv = receivablesSummary(state.receivables);
  const inv = summarizeInventory(state.products);
  const lowCount = lowStockProducts(state.products).length;
  const usd = (v) => formatUsd(v);

  return `
    <section class="home-view">
      <div class="dashboard-grid secondary">
        ${metricCard('Por cobrar', usd(recv.balanceUsd), `${recv.openCount} creditos abiertos`, '')}
        ${metricCard('Valor inventario', usd(inv.valueUsd), `${inv.productCount} productos`, '')}
        ${metricCard('Clientes', state.customers.length, `${state.customers.filter((c) => (c.status || '').toLowerCase() === 'activo').length} activos`, '')}
        ${metricCard('Alertas stock', lowCount, 'En o bajo el minimo', lowCount ? 'solid' : '')}
      </div>

      <div class="home-grid">
        <article class="chart-card wide">
          <h3>Ventas por dia</h3>
          ${renderVBars(byDay, { label: 'dayLabel', value: 'salesUsd', fmt: usd })}
        </article>
        <article class="chart-card">
          <h3>Utilidad estimada vs real</h3>
          <div class="profit-compare">
            <div><span>Ventas</span><strong>${usd(profit.salesUsd)}</strong></div>
            <div><span>Utilidad estimada</span><strong class="pos-cell">${usd(profit.estimatedProfitUsd)}</strong></div>
            <div><span>Utilidad real</span><strong class="pos-cell">${usd(profit.realProfitUsd)}</strong></div>
            <div><span>Costo real</span><strong>${usd(profit.realCostUsd)}</strong></div>
          </div>
        </article>
        <article class="chart-card">
          <h3>Productos mas vendidos</h3>
          ${renderHBars(top, { label: 'name', value: 'quantity', fmt: (v) => `${v}` })}
        </article>
        <article class="chart-card">
          <h3>Ventas por metodo de pago</h3>
          ${renderHBars(byMethod, { label: 'method', value: 'salesUsd', fmt: usd })}
        </article>
      </div>

      <article class="chart-card wide">
        <h3>Pedidos recientes</h3>
        ${
          orders.length
            ? `<div class="movement-list">${orders
                .slice(0, 6)
                .map(
                  (o) => `<div class="movement-row"><span>#${o.orderNumber} · ${o.date} · ${(o.customerName || '').trim() || 'Mostrador'} · ${o.payment?.methodName || ''}${o.status === 'annulled' ? ' · ANULADO' : ''}</span><strong>${formatUsd(o.totals?.totalUsd || 0)}</strong></div>`
                )
                .join('')}</div>`
            : '<div class="chart-empty">Aun no hay pedidos. Haz tu primera venta en Pedidos.</div>'
        }
      </article>
    </section>
  `;
}

function rateDiffBadge() {
  const bcv = bcvRateValue();
  if (!bcv) return '';
  const diff = rateDifference(currentOrder.exchangeRate.value, bcv);
  if (!diff.diffBs) return `<small class="rate-diff neutral">= BCV ${bcv}</small>`;
  const sign = diff.diffBs > 0 ? '+' : '';
  return `<small class="rate-diff ${diff.diffBs > 0 ? 'up' : 'down'}">vs BCV ${bcv} · ${sign}${diff.percent}%</small>`;
}

function metricCard(title, value, caption, variant) {
  return `
    <article class="metric-card ${variant}">
      <span>${title}</span>
      <strong>${value}</strong>
      <small>${caption}</small>
    </article>
  `;
}

function renderPos(totals) {
  const products = filteredProducts();
  return `
    <section class="pos-grid">
      <div class="sales-panel">
        <div class="control-strip">
          <label>Canal
            <select data-field="channel">
              ${option('Mayor', currentOrder.channel)}
              ${option('Detal', currentOrder.channel)}
              ${option('Delivery', currentOrder.channel)}
            </select>
          </label>
          <label>Ubicacion
            <select data-field="location">
              ${option('Todas', currentOrder.location)}
              ${option('Galpon', currentOrder.location)}
              ${option('Caracas', currentOrder.location)}
            </select>
          </label>
          <label>Tasa Bs/$
            <input class="rate-input" type="number" step="0.01" value="${currentOrder.exchangeRate.value}" data-field="rate" />
            ${rateDiffBadge()}
          </label>
          <button class="toggle-button" data-action="toggle-currency">${state.settings.currencyView}</button>
        </div>
        <div class="search-row">
          <input type="search" placeholder="Buscar productos, codigo o categoria..." value="${search}" data-field="search" />
          <button class="scan-button" data-action="scan">Escanear</button>
        </div>
        <div class="section-heading">
          <h2>Catalogo operativo</h2>
          <p>Vende desde catalogo. Solo inventariable descuenta stock.</p>
        </div>
        <div class="product-grid">
          ${products.map(renderProductCard).join('')}
        </div>
      </div>
      ${renderOrderPanel(totals)}
    </section>
  `;
}

function option(value, selected) {
  return `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`;
}

function renderProductCard(product) {
  const stockLabel = product.stock === null ? 'Sin stock' : `${product.stock} ${product.unit}`;
  return `
    <button class="product-card" data-product-id="${product.id}">
      <div>
        <span class="sku">${product.sku}</span>
        <span class="stock">${stockLabel}</span>
      </div>
      <strong>${product.name}</strong>
      <small>${controlModeLabel(product.controlMode)}</small>
      <b>${money(productPrice(product, currentOrder.channel))}</b>
    </button>
  `;
}

function renderCustomerSuggestions() {
  const q = customerQuery.trim().toLowerCase();
  if (q.length < 2) return '';
  const matches = state.customers
    .filter((c) => `${c.name} ${c.idDoc} ${c.phone} ${c.number}`.toLowerCase().includes(q))
    .slice(0, 6);
  if (!matches.length) {
    return '<div class="customer-suggest"><div class="suggest-empty">Sin clientes. Agregalo en el modulo Clientes.</div></div>';
  }
  return `<div class="customer-suggest">${matches
    .map(
      (c) => `<button class="suggest-item" data-customer-pick="${c.id}"><strong>${c.name}</strong><small>${c.idDoc || ''} ${c.phone || ''}</small></button>`
    )
    .join('')}</div>`;
}

function renderCustomerField() {
  if (currentOrder.customerId) {
    return `
      <div class="customer-selected">
        <span>${currentOrder.customerName}</span>
        <button data-action="clear-customer" title="Quitar cliente">x</button>
      </div>`;
  }
  const placeholder =
    paymentMode === 'credito' ? 'Buscar cliente (obligatorio para credito)' : 'Buscar cliente (opcional)';
  return `
    <div class="customer-field">
      <input class="client-input" placeholder="${placeholder}" value="${customerQuery}" data-field="order-customer" autocomplete="off" />
      ${renderCustomerSuggestions()}
    </div>`;
}

function renderOrderPanel(totals) {
  const isCredit = paymentMode === 'credito';
  const canFinalize = currentOrder.items.length && (!isCredit || currentOrder.customerId);
  return `
    <aside class="order-panel">
      <div class="panel-title">
        <h2>Pedido #${currentOrder.orderNumber}</h2>
        <span>${currentOrder.exchangeRate.source.toUpperCase()}</span>
      </div>
      ${renderCustomerField()}
      <div class="cart-list">
        ${
          currentOrder.items.length
            ? currentOrder.items.map(renderCartItem).join('')
            : '<div class="empty-cart">Agrega productos al pedido</div>'
        }
      </div>
      <div class="tax-row">
        <label><input type="checkbox" data-field="iva" ${currentOrder.applyIva ? 'checked' : ''}/> IVA 16%</label>
        <label><input type="checkbox" data-field="igtf" ${currentOrder.applyIgtf ? 'checked' : ''}/> IGTF 3%</label>
      </div>
      <label class="notes-label">Observaciones
        <textarea rows="2" data-field="notes" placeholder="Nota para factura, despacho o proveedor...">${currentOrder.notes}</textarea>
      </label>
      <div class="totals-box">
        <div><span>Subtotal</span><strong>${formatUsd(totals.subtotalUsd)} <small>${formatVes(chargedBs(totals.subtotalUsd))}</small></strong></div>
        <div><span>IVA</span><strong>${formatUsd(totals.ivaUsd)}</strong></div>
        <div><span>IGTF</span><strong>${formatUsd(totals.igtfUsd)}</strong></div>
        <div><span>Margen estimado</span><strong>${formatUsd(totals.estimatedMarginUsd)}</strong></div>
        <div class="grand-total"><span>Total</span><strong>${formatUsd(totals.totalUsd)} <small>${formatVes(chargedBs(totals.totalUsd))}</small></strong></div>
      </div>
      <div class="pay-mode">
        <button class="pay-mode-btn ${isCredit ? '' : 'active'}" data-pay-mode="contado">Pago de una</button>
        <button class="pay-mode-btn ${isCredit ? 'active' : ''}" data-pay-mode="credito">Credito</button>
      </div>
      ${
        isCredit
          ? `<div class="credit-note">${
              currentOrder.customerId
                ? `Se registrara como cuenta por cobrar de <strong>${currentOrder.customerName}</strong>.`
                : 'Selecciona un cliente del sistema para dar credito.'
            }</div>`
          : `<div class="payment-methods">${state.paymentMethods.map(renderPaymentMethod).join('')}</div>`
      }
      <button class="finish-button" data-action="finalize" ${canFinalize ? '' : 'disabled'}>
        ${isCredit ? 'Registrar credito' : 'Finalizar pedido'} ${formatUsd(totals.totalUsd)}
      </button>
      <button class="expand-button" data-view="checkout" ${currentOrder.items.length ? '' : 'disabled'}>Ver pedido en pantalla completa</button>
      <button class="quote-button" data-action="download-quote" ${currentOrder.items.length ? '' : 'disabled'}>Descargar cotizacion</button>
    </aside>
  `;
}

function renderCheckout(totals) {
  const isCredit = paymentMode === 'credito';
  const canFinalize = currentOrder.items.length && (!isCredit || currentOrder.customerId);
  return `
    <section class="checkout-view">
      <div class="checkout-head">
        <button class="ghost-button compact" data-view="pos">&larr; Volver al catalogo</button>
        <h1>Pedido #${currentOrder.orderNumber}</h1>
        <span class="status-pill prepared">${currentOrder.exchangeRate.source.toUpperCase()} · ${currentOrder.exchangeRate.value} Bs/$</span>
      </div>
      <div class="checkout-grid">
        <div class="checkout-main">
          <label class="checkout-customer-label">Cliente
            ${renderCustomerField()}
          </label>
          <div class="table-wrap">
            <table class="checkout-table">
              <thead><tr>
                <th>Producto</th><th>Modo</th><th>Cantidad</th><th>Precio U.</th><th>Total</th><th></th>
              </tr></thead>
              <tbody>
                ${
                  currentOrder.items.length
                    ? currentOrder.items.map(renderCheckoutRow).join('')
                    : '<tr><td colspan="6" class="muted-cell">Sin productos. Agregalos desde el catalogo o Importar.</td></tr>'
                }
              </tbody>
            </table>
          </div>
          <button class="add-row-button" data-view="pos">+ Agregar mas productos</button>
        </div>

        <aside class="checkout-summary">
          <div class="tax-row">
            <label><input type="checkbox" data-field="iva" ${currentOrder.applyIva ? 'checked' : ''}/> IVA 16%</label>
            <label><input type="checkbox" data-field="igtf" ${currentOrder.applyIgtf ? 'checked' : ''}/> IGTF 3%</label>
          </div>
          <label class="notes-label">Observaciones
            <textarea rows="2" data-field="notes" placeholder="Nota para factura, despacho o proveedor...">${currentOrder.notes}</textarea>
          </label>
          <div class="totals-box">
            <div><span>Subtotal</span><strong>${formatUsd(totals.subtotalUsd)} <small>${formatVes(chargedBs(totals.subtotalUsd))}</small></strong></div>
            <div><span>IVA</span><strong>${formatUsd(totals.ivaUsd)}</strong></div>
            <div><span>IGTF</span><strong>${formatUsd(totals.igtfUsd)}</strong></div>
            <div><span>Margen estimado</span><strong>${formatUsd(totals.estimatedMarginUsd)}</strong></div>
            <div class="grand-total"><span>Total</span><strong>${formatUsd(totals.totalUsd)} <small>${formatVes(chargedBs(totals.totalUsd))}</small></strong></div>
          </div>
          <div class="pay-mode">
            <button class="pay-mode-btn ${isCredit ? '' : 'active'}" data-pay-mode="contado">Pago de una</button>
            <button class="pay-mode-btn ${isCredit ? 'active' : ''}" data-pay-mode="credito">Credito</button>
          </div>
          ${
            isCredit
              ? `<div class="credit-note">${
                  currentOrder.customerId
                    ? `Se registrara como cuenta por cobrar de <strong>${currentOrder.customerName}</strong>.`
                    : 'Selecciona un cliente del sistema para dar credito.'
                }</div>`
              : `<div class="payment-methods">${state.paymentMethods.map(renderPaymentMethod).join('')}</div>`
          }
          <button class="finish-button" data-action="finalize" ${canFinalize ? '' : 'disabled'}>
            ${isCredit ? 'Registrar credito' : 'Finalizar pedido'} ${formatUsd(totals.totalUsd)}
          </button>
          <button class="quote-button" data-action="download-quote" ${currentOrder.items.length ? '' : 'disabled'}>Descargar cotizacion</button>
        </aside>
      </div>
    </section>
  `;
}

function renderCheckoutRow(item) {
  return `
    <tr>
      <td><strong>${item.name}</strong></td>
      <td><small>${controlModeLabel(item.controlMode)}${item.supplierName ? ` · ${item.supplierName}` : ''}</small></td>
      <td><div class="qty-cell"><input class="cell-input" type="number" min="0" step="0.1" value="${item.quantity}" data-item-qty="${item.id}" /><span>${item.unit || ''}</span></div></td>
      <td>${formatUsd(item.priceUsd)}</td>
      <td class="num"><strong>${formatUsd(item.quantity * item.priceUsd)}</strong></td>
      <td><button class="row-remove" data-remove-item="${item.id}">x</button></td>
    </tr>
  `;
}

function renderCartItem(item) {
  return `
    <article class="cart-item">
      <button data-remove-item="${item.id}">x</button>
      <div>
        <strong>${item.name}</strong>
        <small>${controlModeLabel(item.controlMode)} · ${item.supplierName || 'Propio'}</small>
      </div>
      <input type="number" min="0" step="0.1" value="${item.quantity}" data-item-qty="${item.id}" />
      <b>${formatUsd(item.quantity * item.priceUsd)}</b>
    </article>
  `;
}

function renderPaymentMethod(method) {
  return `
    <button class="payment-chip ${selectedPaymentMethod === method.id ? 'selected' : ''}" data-payment-id="${method.id}">
      <strong>${method.name}</strong>
      <small>${method.accountName}</small>
    </button>
  `;
}

function renderCatalog() {
  return `
    <section class="catalog-panel">
      <div class="section-heading">
        <h2>Catalogo flexible</h2>
        <p>El modo define si afecta inventario, crea orden al galpon o se vende como servicio.</p>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Codigo</th><th>Producto</th><th>Modo</th><th>Precio</th><th>Costo est.</th><th>Stock</th></tr></thead>
          <tbody>
            ${[...state.products]
              .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
              .map(
                (product) => `
                  <tr>
                    <td>${product.sku}</td>
                    <td>${product.name}</td>
                    <td><span class="mode-pill">${controlModeLabel(product.controlMode)}</span></td>
                    <td>${formatUsd(product.priceUsd)}</td>
                    <td>${formatUsd(product.estimatedCostUsd)}</td>
                    <td>${product.stock ?? 'No aplica'} ${product.stock === null ? '' : product.unit}</td>
                  </tr>
                `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderInventory() {
  const inventoryProducts = state.products.filter(isInventoryProduct);
  const summary = summarizeInventory(state.products);
  const alerts = lowStockProducts(state.products);
  const movements = state.inventoryMovements;
  const isPurchase = inventoryForm.mode === 'purchase';

  return `
    <section class="inventory-panel">
      <div class="section-heading">
        <h2>Inventario opcional</h2>
        <p>Solo los productos en modo Inventario afectan stock. Bajo pedido nunca descuenta.</p>
      </div>

      <div class="dashboard-grid">
        ${metricCard('Productos inventario', summary.productCount, 'Con control de stock', '')}
        ${metricCard('Valor inventario', formatUsd(summary.valueUsd), 'A costo estimado', 'solid')}
        ${metricCard('Alertas stock bajo', summary.lowStockCount, 'En o bajo el minimo', summary.lowStockCount ? 'solid' : '')}
      </div>

      ${
        alerts.length
          ? `<div class="stock-alerts">
              <strong>Stock bajo</strong>
              ${alerts
                .map(
                  (product) =>
                    `<span class="alert-pill">${product.name}: ${product.stock} ${product.unit} (min ${product.minStock ?? 5})</span>`
                )
                .join('')}
            </div>`
          : ''
      }

      <div class="inventory-grid">
        <form class="inventory-form" data-action="inventory-submit">
          <div class="form-toggle">
            <button type="button" class="toggle-button ${isPurchase ? 'selected' : ''}" data-inv-mode="purchase">Compra (entrada)</button>
            <button type="button" class="toggle-button ${isPurchase ? '' : 'selected'}" data-inv-mode="adjustment">Ajuste manual</button>
          </div>
          <label>Producto
            <select data-inv-field="productId">
              <option value="">Selecciona...</option>
              ${inventoryProducts
                .map(
                  (product) =>
                    `<option value="${product.id}" ${inventoryForm.productId === product.id ? 'selected' : ''}>${product.name} (${product.stock} ${product.unit})</option>`
                )
                .join('')}
            </select>
          </label>
          <label>${isPurchase ? 'Cantidad a ingresar' : 'Cantidad (+/-)'}
            <input type="number" step="0.1" data-inv-field="quantity" value="${inventoryForm.quantity}" placeholder="${isPurchase ? '20' : '-2 para merma'}" />
          </label>
          ${
            isPurchase
              ? `<label>Costo unitario USD
                  <input type="number" step="0.01" data-inv-field="unitCostUsd" value="${inventoryForm.unitCostUsd}" placeholder="Costo estimado si vacio" />
                </label>`
              : ''
          }
          <label>Nota
            <input type="text" data-inv-field="note" value="${inventoryForm.note}" placeholder="${isPurchase ? 'Factura proveedor...' : 'Motivo del ajuste...'}" />
          </label>
          <button type="submit" class="primary-button" ${inventoryForm.productId ? '' : 'disabled'}>
            ${isPurchase ? 'Registrar compra' : 'Registrar ajuste'}
          </button>
        </form>

        <div class="kardex-wrap">
          <h3>Kardex por producto</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Producto</th><th>Inicial</th><th>Entradas</th><th>Salidas</th><th>Ajustes</th><th>Final</th></tr></thead>
              <tbody>
                ${inventoryProducts
                  .map((product) => {
                    const k = buildProductKardex(product, movements);
                    return `
                      <tr>
                        <td>${k.name}</td>
                        <td>${k.initial}</td>
                        <td class="pos-cell">${k.entries}</td>
                        <td class="neg-cell">${k.exits}</td>
                        <td>${k.adjustments}</td>
                        <td><strong>${k.final}</strong></td>
                      </tr>
                    `;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="movement-list">
        <h3>Movimientos de inventario</h3>
        ${
          movements.length
            ? movements
                .slice(0, 12)
                .map(
                  (movement) => `
                    <div class="movement-row">
                      <span>${invMovementLabel(movement.type)} · ${movement.name} · ${movement.note}</span>
                      <strong class="${movement.quantity >= 0 ? 'pos-cell' : 'neg-cell'}">${movement.quantity >= 0 ? '+' : ''}${movement.quantity}</strong>
                    </div>
                  `
                )
                .join('')
            : '<div class="empty-cart">Registra una compra o finaliza una venta de producto inventariable</div>'
        }
      </div>
    </section>
  `;
}

function invMovementLabel(type) {
  return { purchase: 'Compra', sale: 'Venta', adjustment: 'Ajuste' }[type] || type;
}

function reportDefinitions() {
  const orders = state.orders;
  return [
    {
      id: 'ventas-dia',
      title: 'Ventas por dia',
      columns: [
        { key: 'date', label: 'Fecha' },
        { key: 'count', label: 'Pedidos' },
        { key: 'salesUsd', label: 'Ventas USD', money: true },
        { key: 'marginUsd', label: 'Margen USD', money: true }
      ],
      rows: salesByDay(orders)
    },
    {
      id: 'ventas-mes',
      title: 'Ventas por mes',
      columns: [
        { key: 'month', label: 'Mes' },
        { key: 'count', label: 'Pedidos' },
        { key: 'salesUsd', label: 'Ventas USD', money: true },
        { key: 'marginUsd', label: 'Margen USD', money: true }
      ],
      rows: salesByMonth(orders)
    },
    {
      id: 'ventas-canal',
      title: 'Ventas por canal',
      columns: [
        { key: 'channel', label: 'Canal' },
        { key: 'count', label: 'Pedidos' },
        { key: 'salesUsd', label: 'Ventas USD', money: true }
      ],
      rows: salesByChannel(orders)
    },
    {
      id: 'ventas-metodo',
      title: 'Ventas por metodo de pago',
      columns: [
        { key: 'method', label: 'Metodo' },
        { key: 'count', label: 'Pedidos' },
        { key: 'salesUsd', label: 'Ventas USD', money: true }
      ],
      rows: salesByPaymentMethod(orders)
    },
    {
      id: 'top-productos',
      title: 'Productos mas vendidos',
      columns: [
        { key: 'sku', label: 'Codigo' },
        { key: 'name', label: 'Producto' },
        { key: 'quantity', label: 'Cantidad' },
        { key: 'salesUsd', label: 'Ventas USD', money: true },
        { key: 'marginUsd', label: 'Margen USD', money: true }
      ],
      rows: topProducts(orders)
    },
    {
      id: 'mejor-margen',
      title: 'Productos con mejor margen',
      columns: [
        { key: 'sku', label: 'Codigo' },
        { key: 'name', label: 'Producto' },
        { key: 'marginUsd', label: 'Margen USD', money: true },
        { key: 'salesUsd', label: 'Ventas USD', money: true }
      ],
      rows: bestMarginProducts(orders)
    },
    {
      id: 'clientes',
      title: 'Clientes frecuentes',
      columns: [
        { key: 'name', label: 'Cliente' },
        { key: 'count', label: 'Pedidos' },
        { key: 'salesUsd', label: 'Ventas USD', money: true }
      ],
      rows: frequentCustomers(orders)
    }
  ];
}

function renderReports() {
  const summary = profitSummary(state.orders, state.supplierOrders);
  const defs = reportDefinitions();
  return `
    <section class="reports-panel">
      <div class="section-heading">
        <h2>Reportes</h2>
        <button class="primary-button compact" data-action="print-report">Imprimir / PDF</button>
      </div>
      <div class="dashboard-grid">
        ${metricCard('Ventas totales', formatUsd(summary.salesUsd), `${summary.orderCount} pedidos`, 'solid')}
        ${metricCard('Utilidad estimada', formatUsd(summary.estimatedProfitUsd), 'Con costo estimado', '')}
        ${metricCard('Utilidad real', formatUsd(summary.realProfitUsd), 'Con costo real galpon', 'solid')}
        ${metricCard('Costo real', formatUsd(summary.realCostUsd), 'Mercancia vendida', '')}
      </div>
      <div class="reports-grid">
        ${defs.map(renderReportTable).join('')}
      </div>
    </section>
  `;
}

function renderReportTable(def) {
  return `
    <article class="report-card">
      <div class="report-head">
        <h3>${def.title}</h3>
        <button class="ghost-button compact" data-export-csv="${def.id}">Excel</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>${def.columns.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>
          <tbody>
            ${
              def.rows.length
                ? def.rows
                    .map(
                      (row) =>
                        `<tr>${def.columns
                          .map((c) => `<td>${c.money ? formatUsd(row[c.key]) : row[c.key]}</td>`)
                          .join('')}</tr>`
                    )
                    .join('')
                : `<tr><td colspan="${def.columns.length}" class="muted-cell">Sin ventas registradas todavia</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </article>
  `;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportReportCsv(id) {
  const def = reportDefinitions().find((d) => d.id === id);
  if (!def) return;
  const header = def.columns.map((c) => csvCell(c.label)).join(';');
  const lines = def.rows.map((row) => def.columns.map((c) => csvCell(row[c.key])).join(';'));
  const csv = '﻿' + [header, ...lines].join('\r\n');
  downloadFile(`${def.id}.csv`, csv, 'text/csv;charset=utf-8');
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function printReport() {
  const summary = profitSummary(state.orders, state.supplierOrders);
  const defs = reportDefinitions();
  const today = new Date().toISOString().slice(0, 10);
  const tableHtml = defs
    .map(
      (def) => `
        <h2>${def.title}</h2>
        <table>
          <thead><tr>${def.columns.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>
          <tbody>
            ${
              def.rows.length
                ? def.rows
                    .map(
                      (row) =>
                        `<tr>${def.columns
                          .map((c) => `<td>${c.money ? formatUsd(row[c.key]) : row[c.key]}</td>`)
                          .join('')}</tr>`
                    )
                    .join('')
                : `<tr><td colspan="${def.columns.length}">Sin datos</td></tr>`
            }
          </tbody>
        </table>`
    )
    .join('');

  const doc = `<!doctype html><html lang="es"><head><meta charset="utf-8" />
    <title>Reporte Veggies CCS ${today}</title>
    <style>
      body { font-family: Arial, sans-serif; color: #172033; padding: 24px; }
      h1 { color: #1f8f37; margin: 0 0 4px; }
      .sub { color: #7a8496; margin: 0 0 18px; }
      .cards { display: flex; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
      .card { border: 1px solid #e4e8f1; border-radius: 8px; padding: 10px 14px; }
      .card span { display: block; color: #7a8496; font-size: 12px; }
      .card strong { font-size: 18px; }
      h2 { color: #136b27; font-size: 15px; margin: 18px 0 6px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 12px; }
      th, td { border: 1px solid #e4e8f1; padding: 6px 8px; text-align: left; }
      th { background: #e6f4ea; }
    </style></head><body>
    <h1>Veggies CCS</h1>
    <p class="sub">Reporte de ventas y utilidad · ${today}</p>
    <div class="cards">
      <div class="card"><span>Ventas totales</span><strong>${formatUsd(summary.salesUsd)}</strong></div>
      <div class="card"><span>Utilidad estimada</span><strong>${formatUsd(summary.estimatedProfitUsd)}</strong></div>
      <div class="card"><span>Utilidad real</span><strong>${formatUsd(summary.realProfitUsd)}</strong></div>
      <div class="card"><span>Pedidos</span><strong>${summary.orderCount}</strong></div>
    </div>
    ${tableHtml}
    </body></html>`;

  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(doc);
  win.document.close();
  win.focus();
  win.print();
}

function renderDocuments() {
  const orders = state.orders;
  return `
    <section class="documents-panel">
      <div class="section-heading">
        <h2>Documentos</h2>
        <p>Genera cotizaciones, notas de entrega, facturas y recibos con numeracion correlativa.</p>
      </div>
      <div class="docs-order-list">
        ${
          orders.length
            ? orders.map(renderDocumentOrderRow).join('')
            : '<div class="empty-cart">Finaliza un pedido para generar documentos</div>'
        }
      </div>
      ${
        state.documents.length
          ? `<div class="movement-list">
              <h3>Documentos emitidos</h3>
              ${state.documents
                .slice(0, 12)
                .map(
                  (doc) => `
                    <div class="movement-row">
                      <span><strong>${doc.number}</strong> · ${doc.label} · ${doc.customerName} · Pedido #${doc.orderNumber}</span>
                      <button class="ghost-button compact" data-reprint="${doc.id}">Ver</button>
                    </div>`
                )
                .join('')}
            </div>`
          : ''
      }
    </section>
  `;
}

function renderDocumentOrderRow(order) {
  const totals = order.totals || calculateOrderTotals(order);
  const annulled = order.status === 'annulled';
  return `
    <article class="docs-order ${annulled ? 'annulled' : ''}">
      <div class="docs-order-head">
        <div>
          <span class="sku">Pedido #${order.orderNumber} · ${order.date}</span>
          <h3>${(order.customerName || '').trim() || 'Mostrador'}</h3>
        </div>
        <div class="docs-order-total">
          <strong>${formatUsd(totals.totalUsd)}</strong>
          <span class="status-pill ${annulled ? 'annulled' : 'delivered'}">${annulled ? 'Anulado' : 'Finalizado'}</span>
        </div>
      </div>
      <div class="docs-actions">
        <button class="ghost-button compact" data-doc="cotizacion|${order.id}">Cotizacion</button>
        <button class="ghost-button compact" data-doc="nota_entrega|${order.id}">Nota entrega</button>
        <button class="ghost-button compact" data-doc="factura|${order.id}">Factura</button>
        <button class="ghost-button compact" data-doc="recibo|${order.id}">Recibo</button>
        <button class="ghost-button compact" data-thermal="${order.id}">Termico</button>
        <button class="wa-button compact" data-wa="${order.id}">WhatsApp</button>
        ${annulled ? '' : `<button class="coral-button compact" data-annul="${order.id}">Anular</button>`}
      </div>
    </article>
  `;
}

function generateDocument(type, orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  const source = order.totals ? order : { ...order, totals: calculateOrderTotals(order) };
  const number = nextDocumentNumber(state.documents, type);
  const doc = createDocument({ order: source, type, number });
  setState(() => {
    state.documents = [doc, ...state.documents];
  });
  openPrintWindow(documentHtml(doc), `${doc.label} ${doc.number}`);
}

function reprintDocument(docId) {
  const doc = state.documents.find((item) => item.id === docId);
  if (doc) openPrintWindow(documentHtml(doc), `${doc.label} ${doc.number}`);
}

function openPrintWindow(bodyHtml, title) {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(bodyHtml.replace('{{TITLE}}', title));
  win.document.close();
  win.focus();
  win.print();
}

function docLogoUrl() {
  return `${location.origin}/src/assets/logo-veggies.png`;
}

function documentHtml(doc) {
  const t = doc.totals || {};
  const showPayment = (doc.type === 'factura' || doc.type === 'recibo') && doc.payment;
  const rate = doc.exchangeRate || 0;
  const itemsHtml = doc.items
    .map(
      (item) => `
        <tr>
          <td>${item.sku || ''}</td>
          <td>${item.name}</td>
          <td class="num">${item.quantity} ${item.unit}</td>
          <td class="num">${formatUsd(item.priceUsd)}</td>
          <td class="num">${formatUsd(item.totalUsd)}</td>
        </tr>`
    )
    .join('');

  const totalsRows = `
    <tr><td>Subtotal</td><td class="num">${formatUsd(t.subtotalUsd || 0)}</td></tr>
    ${t.discountUsd ? `<tr><td>Descuento</td><td class="num">- ${formatUsd(t.discountUsd)}</td></tr>` : ''}
    ${t.ivaUsd ? `<tr><td>IVA 16%</td><td class="num">${formatUsd(t.ivaUsd)}</td></tr>` : ''}
    ${t.igtfUsd ? `<tr><td>IGTF 3%</td><td class="num">${formatUsd(t.igtfUsd)}</td></tr>` : ''}
    ${t.extraChargeUsd ? `<tr><td>Cargo extra</td><td class="num">${formatUsd(t.extraChargeUsd)}</td></tr>` : ''}
    <tr class="grand"><td>Total USD</td><td class="num">${formatUsd(t.totalUsd || 0)}</td></tr>
    <tr class="grand"><td>Total Bs</td><td class="num">${formatVes(t.totalVes || (t.totalUsd || 0) * rate)}</td></tr>
  `;

  const footer =
    doc.type === 'cotizacion'
      ? 'Cotizacion valida por 24 horas, sujeta a disponibilidad y a la tasa del dia.'
      : doc.type === 'nota_entrega'
      ? 'Recibi conforme la mercancia descrita. Firma: ____________________'
      : 'Documento interno generado por Veggies CCS.';

  return `<!doctype html><html lang="es"><head><meta charset="utf-8" />
    <title>{{TITLE}}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: Arial, Helvetica, sans-serif; color: #172033; margin: 0; padding: 32px; }
      .doc-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1f8f37; padding-bottom: 14px; }
      .doc-logo { height: 56px; }
      .doc-meta { text-align: right; }
      .doc-meta h1 { color: #1f8f37; font-size: 20px; margin: 0 0 4px; text-transform: uppercase; }
      .doc-meta .num { font-size: 16px; font-weight: bold; }
      .doc-meta span { display: block; color: #7a8496; font-size: 12px; }
      .parties { display: flex; justify-content: space-between; margin: 18px 0; font-size: 13px; }
      .parties strong { display: block; color: #136b27; margin-bottom: 2px; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      thead th { background: #e6f4ea; color: #136b27; text-align: left; padding: 8px; }
      td { padding: 7px 8px; border-bottom: 1px solid #eef1f6; }
      td.num, th.num { text-align: right; }
      .totals { width: 280px; margin-left: auto; margin-top: 14px; }
      .totals td { border: none; padding: 4px 8px; }
      .totals .grand td { border-top: 2px solid #1f8f37; font-weight: bold; font-size: 15px; color: #136b27; }
      .pay { margin-top: 16px; padding: 12px 14px; background: #e6f4ea; border-radius: 8px; font-size: 13px; }
      .foot { margin-top: 28px; color: #7a8496; font-size: 12px; border-top: 1px solid #eef1f6; padding-top: 10px; }
    </style></head><body>
    <div class="doc-head">
      <img src="${docLogoUrl()}" class="doc-logo" alt="Veggies CCS" />
      <div class="doc-meta">
        <h1>${doc.label}</h1>
        <span class="num">${doc.number}</span>
        <span>Fecha: ${doc.date}</span>
        <span>Pedido #${doc.orderNumber}</span>
        ${rate ? `<span>Tasa: ${rate} Bs/$</span>` : ''}
      </div>
    </div>
    <div class="parties">
      <div><strong>Emisor</strong>${state.settings.companyName}<br/>Caracas · Venezuela</div>
      <div style="text-align:right"><strong>Cliente</strong>${doc.customerName}</div>
    </div>
    <table>
      <thead><tr><th>Codigo</th><th>Producto</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Total</th></tr></thead>
      <tbody>${itemsHtml}</tbody>
    </table>
    <table class="totals"><tbody>${totalsRows}</tbody></table>
    ${
      showPayment
        ? `<div class="pay"><strong>Pago:</strong> ${doc.payment.methodName} · ${formatUsd(doc.payment.amountUsd)}${doc.payment.amountVes ? ` / ${formatVes(doc.payment.amountVes)}` : ''}</div>`
        : ''
    }
    <p class="foot">${footer}</p>
    </body></html>`;
}

function thermalPrint(orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  const t = order.totals || calculateOrderTotals(order);
  const itemsHtml = order.items
    .map(
      (item) => `
        <div class="trow"><span>${item.quantity} ${item.unit} ${item.name}</span><b>${formatUsd(item.quantity * item.priceUsd)}</b></div>`
    )
    .join('');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8" /><title>{{TITLE}}</title>
    <style>
      @page { size: 80mm auto; margin: 4mm; }
      body { font-family: "Courier New", monospace; color: #000; width: 72mm; margin: 0 auto; font-size: 12px; }
      .center { text-align: center; }
      .brand { font-size: 18px; font-weight: bold; }
      .line { border-top: 1px dashed #000; margin: 6px 0; }
      .trow { display: flex; justify-content: space-between; gap: 8px; margin: 2px 0; }
      .total { display: flex; justify-content: space-between; font-size: 14px; font-weight: bold; }
      .muted { color: #333; font-size: 11px; }
    </style></head><body>
    <div class="center brand">Veggies CCS</div>
    <div class="center muted">Caracas · Venezuela</div>
    <div class="line"></div>
    <div class="muted">Pedido #${order.orderNumber} · ${order.date}</div>
    <div class="muted">Cliente: ${(order.customerName || '').trim() || 'Mostrador'}</div>
    <div class="line"></div>
    ${itemsHtml}
    <div class="line"></div>
    <div class="total"><span>TOTAL</span><span>${formatUsd(t.totalUsd)}</span></div>
    <div class="trow"><span>Equivalente</span><b>${formatVes(t.totalVes || t.totalUsd * (order.exchangeRate?.value || 0))}</b></div>
    ${order.payment ? `<div class="trow"><span>Pago</span><b>${order.payment.methodName}</b></div>` : ''}
    <div class="line"></div>
    <div class="center muted">Gracias por su compra</div>
    </body></html>`;
  openPrintWindow(html, `Recibo termico #${order.orderNumber}`);
}

function whatsappOrder(orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  const t = order.totals || calculateOrderTotals(order);
  const lines = order.items.map(
    (item) => `• ${item.quantity} ${item.unit} ${item.name} — ${formatUsd(item.quantity * item.priceUsd)}`
  );
  const text = [
    '*Veggies CCS*',
    `Pedido #${order.orderNumber} · ${order.date}`,
    `Cliente: ${(order.customerName || '').trim() || 'Mostrador'}`,
    '',
    ...lines,
    '',
    `*Total: ${formatUsd(t.totalUsd)}*`,
    formatVes(t.totalVes || t.totalUsd * (order.exchangeRate?.value || 0)),
    order.exchangeRate ? `Tasa: ${order.exchangeRate.value} Bs/$` : ''
  ]
    .filter(Boolean)
    .join('\n');
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

function annulOrderById(orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order || order.status !== 'paid') return;
  const reason = window.prompt(`Anular Pedido #${order.orderNumber}. Motivo:`, '');
  if (reason === null) return;

  const annulled = annulOrder(order, reason);
  const method = state.paymentMethods.find((m) => m.id === order.payment?.methodId);
  const reversalNote = `Anulacion Pedido #${order.orderNumber}`;

  setState(() => {
    // Reversa de caja
    if (method && order.payment) {
      const amount = method.currency === 'VES' ? order.payment.amountVes : order.payment.amountUsd;
      const reversal = createAdjustmentMovement({
        accountId: method.accountId,
        amount: -Number(amount || 0),
        currency: method.currency === 'VES' ? 'VES' : 'USD',
        note: reversalNote
      });
      state.accountMovements = [reversal, ...state.accountMovements];
      state.accounts = applyMovements(state.accounts, [reversal]);
    }
    // Reversa de inventario (devuelve stock de inventariables)
    const returnMovements = createReturnMovements(order.items, reversalNote);
    if (returnMovements.length) {
      state.inventoryMovements = [...returnMovements, ...state.inventoryMovements];
      state.products = applyInventoryMovements(state.products, returnMovements);
    }
    // Cancela ordenes al galpon vinculadas
    state.supplierOrders = state.supplierOrders.map((so) =>
      so.saleOrderId === order.id ? { ...so, status: 'cancelled' } : so
    );
    // Marca el pedido anulado
    state.orders = state.orders.map((o) => (o.id === order.id ? annulled : o));
  });
}

function renderImport() {
  const rows = importState.rows;
  const totals = preInvoiceTotals(rows);
  return `
    <section class="import-panel">
      <div class="section-heading">
        <h2>Importar factura del proveedor</h2>
        <p>Sube la foto o pega el texto. El precio del proveedor se carga como costo; tu defines el margen.</p>
      </div>

      <div class="import-inputs">
        <div class="import-card">
          <h3>Subir foto</h3>
          <input type="file" accept="image/*" data-import-file ${importState.busy ? 'disabled' : ''} />
          <small>La app lee la imagen con OCR. Funciona mejor con fotos rectas y nitidas.</small>
        </div>
        <div class="import-card">
          <h3>Pegar texto</h3>
          <textarea rows="5" data-import-text placeholder="Pega aqui el texto de la factura...">${importState.rawText}</textarea>
          <button class="primary-button compact" data-action="parse-text">Procesar texto</button>
        </div>
      </div>

      ${importState.status ? `<div class="rate-status">${importState.status}</div>` : ''}

      ${
        rows.length
          ? `
        <div class="preinvoice-controls">
          <label>Margen % global
            <input type="number" step="1" data-import-margin value="${importState.marginPct}" />
          </label>
          <button class="ghost-button compact" data-action="apply-margin-all">Aplicar a todos</button>
          <div class="preinvoice-totals">
            <span>Costo: <strong>${formatUsd(totals.costUsd)}</strong></span>
            <span>Venta: <strong>${formatUsd(totals.saleUsd)}</strong></span>
            <span>Margen: <strong>${formatUsd(totals.marginUsd)}</strong></span>
          </div>
        </div>
        <datalist id="catalog-products">
          ${state.products
            .map((p) => `<option value="${(p.name || '').replace(/"/g, '&quot;')}"></option>`)
            .join('')}
        </datalist>
        <div class="table-wrap">
          <table class="preinvoice-table">
            <thead><tr>
              <th>Descripcion</th><th>Und</th><th>Cant</th><th>Costo $</th><th>Margen %</th><th>Precio venta $</th><th>Total venta</th><th></th>
            </tr></thead>
            <tbody>
              ${rows.map(renderPreInvoiceRow).join('')}
            </tbody>
          </table>
        </div>
        <button class="add-row-button" data-action="add-row">+ Agregar renglon</button>
        <div class="import-actions">
          <button class="finish-button" data-action="load-order">Cargar al pedido (${rows.length})</button>
          <button class="quote-button" data-action="import-quote">Generar cotizacion</button>
        </div>`
          : '<div class="empty-cart">Sube una foto o pega el texto para ver la pre-factura editable</div>'
      }
    </section>
  `;
}

function renderPreInvoiceRow(row, index) {
  const lineTotal = Number(row.quantity || 0) * Number(row.priceUsd || 0);
  const badge = row.productId
    ? `<span class="match-badge ok" title="Vinculado al catalogo${row.ocrText ? ` (OCR: ${row.ocrText})` : ''}">✓</span>`
    : `<button class="match-badge add" data-add-catalog="${index}" title="Agregar este producto al catalogo">+</button>`;
  return `
    <tr class="${row.productId ? 'row-matched' : ''}">
      <td><div class="desc-cell">${badge}<input class="cell-input wide" list="catalog-products" data-row="${index}|description" value="${(row.description || '').replace(/"/g, '&quot;')}" placeholder="Escribe o elige del catalogo" /></div></td>
      <td><input class="cell-input tiny" data-row="${index}|unit" value="${row.unit || ''}" /></td>
      <td><input class="cell-input tiny" type="number" step="0.01" data-row="${index}|quantity" value="${row.quantity}" /></td>
      <td><input class="cell-input small" type="number" step="0.01" data-row="${index}|unitCostUsd" value="${row.unitCostUsd}" /></td>
      <td><input class="cell-input tiny" type="number" step="1" data-row="${index}|marginPct" value="${row.marginPct}" /></td>
      <td><input class="cell-input small" type="number" step="0.01" data-row="${index}|priceUsd" value="${row.priceUsd}" /></td>
      <td class="num row-total" data-row-total="${index}">${formatUsd(lineTotal)}</td>
      <td><button class="row-remove" data-remove-row="${index}">x</button></td>
    </tr>
  `;
}

function parseImportText() {
  const textarea = document.querySelector('[data-import-text]');
  const text = textarea ? textarea.value : '';
  importState.rawText = text;
  importState.rows = buildPreInvoiceRows(parseInvoiceText(text), {
    marginPct: importState.marginPct,
    products: state.products
  });
  importState.status = importStatusMessage();
  render();
}

function importStatusMessage() {
  const total = importState.rows.length;
  if (!total) return 'No se detectaron renglones validos. Revisa el texto o pega manualmente.';
  const matched = importState.rows.filter((r) => r.productId).length;
  return `Se detectaron ${total} renglones · ${matched} vinculados al catalogo, ${total - matched} sin coincidencia. Revisa y corrige antes de cargar.`;
}

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => reject(new Error('no se pudo cargar la libreria OCR'));
    document.head.appendChild(script);
  });
}

async function runInvoiceOcr(file) {
  importState.busy = true;
  importState.status = 'Leyendo la imagen con OCR (puede tardar unos segundos)...';
  render();
  try {
    const Tesseract = await loadTesseract();
    const { data } = await Tesseract.recognize(file, 'spa');
    importState.rawText = data.text;
    importState.rows = buildPreInvoiceRows(parseInvoiceText(data.text), {
      marginPct: importState.marginPct,
      products: state.products
    });
    importState.status = importStatusMessage();
  } catch (error) {
    importState.status = `OCR no disponible (${error.message}). Pega el texto manualmente.`;
  } finally {
    importState.busy = false;
    render();
  }
}

// Actualiza un renglon EN VIVO sin re-render (para no perder el foco mientras se escribe).
// Regla: el precio de venta se recalcula solo si cambia el costo o el margen;
// el total se recalcula si cambia el peso, el costo o el precio.
function updateImportRow(index, field, value) {
  const row = importState.rows[index];
  if (!row) return;
  if (['quantity', 'unitCostUsd', 'priceUsd', 'marginPct'].includes(field)) {
    row[field] = Number(value || 0);
  } else {
    row[field] = value;
  }

  // Si la descripcion coincide EXACTO con un producto del catalogo (eligio del
  // desplegable), se vincula: jala SKU y precio de venta, y recalcula el margen.
  if (field === 'description') {
    const target = (value || '').trim().toLowerCase();
    const product = state.products.find((p) => (p.name || '').trim().toLowerCase() === target);
    if (product && product.id !== row.productId) {
      row.productId = product.id;
      row.sku = product.sku || '';
      row.controlMode = product.controlMode || 'on_demand';
      row.supplierName = product.supplierName || '';
      row.priceUsd = roundMoney(product.prices?.Principal ?? product.priceUsd ?? row.priceUsd);
      if (product.estimatedCostUsd != null) row.unitCostUsd = roundMoney(product.estimatedCostUsd);
      row.marginPct = row.unitCostUsd > 0 ? roundMoney((row.priceUsd / row.unitCostUsd - 1) * 100) : row.marginPct;
      render(); // redibuja para mostrar el check ✓ y los precios actualizados
      return;
    }
  }

  const tr = document.querySelector(`[data-row="${index}|${field}"]`)?.closest('tr');

  if (field === 'unitCostUsd' || field === 'marginPct') {
    row.priceUsd = suggestSalePrice(row.unitCostUsd, row.marginPct);
    const priceInput = tr?.querySelector(`[data-row="${index}|priceUsd"]`);
    if (priceInput && document.activeElement !== priceInput) priceInput.value = row.priceUsd;
  } else if (field === 'priceUsd') {
    row.marginPct = row.unitCostUsd > 0 ? roundMoney((row.priceUsd / row.unitCostUsd - 1) * 100) : 0;
    const marginInput = tr?.querySelector(`[data-row="${index}|marginPct"]`);
    if (marginInput && document.activeElement !== marginInput) marginInput.value = row.marginPct;
  }

  const totalCell = tr?.querySelector(`[data-row-total="${index}"]`);
  if (totalCell) totalCell.textContent = formatUsd(Number(row.quantity || 0) * Number(row.priceUsd || 0));
  updateImportTotalsBar();
}

function updateImportTotalsBar() {
  const bar = document.querySelector('.preinvoice-totals');
  if (!bar) return;
  const t = preInvoiceTotals(importState.rows);
  bar.innerHTML = `<span>Costo: <strong>${formatUsd(t.costUsd)}</strong></span><span>Venta: <strong>${formatUsd(t.saleUsd)}</strong></span><span>Margen: <strong>${formatUsd(t.marginUsd)}</strong></span>`;
}

function applyMarginToAll() {
  const input = document.querySelector('[data-import-margin]');
  const margin = Number(input ? input.value : importState.marginPct);
  importState.marginPct = margin;
  importState.rows = importState.rows.map((row) => ({
    ...row,
    marginPct: margin,
    priceUsd: suggestSalePrice(row.unitCostUsd, margin)
  }));
  render();
}

function addRowToCatalog(index) {
  const row = importState.rows[index];
  if (!row) return;
  const name = (row.description || '').trim();
  if (!name) {
    window.alert('Escribe el nombre del producto antes de agregarlo al catalogo.');
    return;
  }
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const existing = state.products.find((p) => norm(p.name) === norm(name));
  if (existing) {
    // Ya existe: solo vincular en vez de duplicar.
    row.productId = existing.id;
    row.sku = existing.sku || '';
    render();
    return;
  }
  const slug = norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let id = `p-${slug || 'nuevo'}`;
  while (state.products.some((p) => p.id === id)) id += '-x';
  const price = roundMoney(Number(row.priceUsd || 0));
  const product = {
    id,
    sku: row.sku || '',
    name,
    unit: row.unit || 'Kg',
    priceUsd: price,
    prices: { Principal: price, Mayor: price },
    estimatedCostUsd: roundMoney(Number(row.unitCostUsd || 0)),
    controlMode: 'on_demand',
    stock: 0,
    supplierId: 'sup-galpon',
    supplierName: 'Galpon Principal',
    category: 'General'
  };
  setState(() => {
    state.products = [...state.products, product];
    importState.rows[index] = { ...row, productId: id, controlMode: 'on_demand', matched: true };
  });
  importState.status = `"${name}" agregado al catalogo y vinculado.`;
  render();
}

function addImportRow() {
  importState.rows = [
    ...importState.rows,
    { description: '', unit: 'Kg', quantity: 1, unitCostUsd: 0, marginPct: importState.marginPct, priceUsd: 0, productId: null, controlMode: 'on_demand', supplierName: '' }
  ];
  render();
}

function buildOrderFromImport() {
  let order = createOrderDraft({
    orderNumber: nextOrderNumber(),
    exchangeRate: state.settings.exchangeRate,
    channel: state.settings.channel,
    location: state.settings.location
  });
  importState.rows
    .filter((row) => (row.description || '').trim() && Number(row.quantity) > 0)
    .forEach((row) => {
      const product = {
        id: row.productId || `imp-${crypto.randomUUID()}`,
        sku: row.sku || '',
        name: row.description.trim(),
        unit: row.unit || 'Und',
        priceUsd: Number(row.priceUsd || 0),
        estimatedCostUsd: Number(row.unitCostUsd || 0),
        controlMode: row.controlMode || 'on_demand',
        supplierName: row.supplierName || ''
      };
      order = addItemToOrder(order, product, Number(row.quantity || 0));
    });
  return order;
}

function loadImportToOrder(thenQuote) {
  if (!importState.rows.length) return;
  currentOrder = buildOrderFromImport();
  importState = { rawText: '', rows: [], status: '', marginPct: importState.marginPct, busy: false };
  activeView = thenQuote ? 'pos' : 'checkout';
  render();
  if (thenQuote) downloadQuote();
}

function filteredCustomers() {
  const needle = customerSearch.trim().toLowerCase();
  if (!needle) return state.customers;
  return state.customers.filter((customer) =>
    `${customer.name} ${customer.idDoc} ${customer.phone} ${customer.number} ${customer.topProduct}`
      .toLowerCase()
      .includes(needle)
  );
}

function renderCustomers() {
  const all = state.customers;
  const rows = filteredCustomers();
  const active = all.filter((c) => (c.status || '').toLowerCase() === 'activo').length;
  const totalSpent = all.reduce((sum, c) => sum + Number(c.totalSpent || 0), 0);
  const totalOrders = all.reduce((sum, c) => sum + Number(c.totalOrders || 0), 0);
  const avgTicket = totalOrders ? totalSpent / totalOrders : 0;

  return `
    <section class="customers-panel">
      <div class="section-heading">
        <h2>Clientes</h2>
        <p>Cartera de clientes con historial de compras.</p>
      </div>
      <div class="dashboard-grid">
        ${metricCard('Clientes', all.length, `${active} activos`, 'solid')}
        ${metricCard('Total gastado', formatUsd(totalSpent), 'Historico', '')}
        ${metricCard('Ordenes totales', totalOrders, 'Acumuladas', '')}
        ${metricCard('Ticket promedio', formatUsd(avgTicket), 'Por orden', 'solid')}
      </div>
      <div class="search-row">
        <input type="search" placeholder="Buscar por nombre, cedula, telefono o producto..." value="${customerSearch}" data-field="customer-search" />
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Cliente</th><th>Cedula/RIF</th><th>Telefono</th><th>Producto top</th>
            <th>Ordenes</th><th>Total gastado</th><th>Ticket prom.</th><th>Estatus</th>
          </tr></thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .slice(0, 200)
                    .map(
                      (c) => `
                        <tr>
                          <td><strong>${c.name}</strong><br/><small class="muted-cell">${c.address || ''}</small></td>
                          <td>${c.idDoc || ''}</td>
                          <td>${c.phone || ''}</td>
                          <td>${c.topProduct || ''}</td>
                          <td>${c.totalOrders}</td>
                          <td>${formatUsd(c.totalSpent)}</td>
                          <td>${formatUsd(c.avgTicket)}</td>
                          <td><span class="status-pill ${(c.status || '').toLowerCase() === 'activo' ? 'delivered' : 'annulled'}">${c.status}</span></td>
                        </tr>`
                    )
                    .join('')
                : '<tr><td colspan="8" class="muted-cell">Sin clientes que coincidan</td></tr>'
            }
          </tbody>
        </table>
      </div>
      <small class="muted-cell">Mostrando ${Math.min(rows.length, 200)} de ${all.length} clientes</small>
    </section>
  `;
}

function renderReceivables() {
  const list = state.receivables;
  const summary = receivablesSummary(list);
  const statusLabels = { open: 'Pendiente', partial: 'Abonado', paid: 'Pagado' };
  return `
    <section class="customers-panel">
      <div class="section-heading">
        <h2>Cuentas por cobrar</h2>
        <p>Ventas a credito. Registra abonos hasta saldar la deuda del cliente.</p>
      </div>
      <div class="dashboard-grid">
        ${metricCard('Por cobrar', formatUsd(summary.balanceUsd), `${summary.openCount} creditos abiertos`, 'solid')}
        ${metricCard('Total a credito', formatUsd(summary.totalUsd), `${summary.totalCount} ventas`, '')}
        ${metricCard('Cobrado', formatUsd(summary.paidUsd), 'Abonos recibidos', '')}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Cliente</th><th>Pedido</th><th>Fecha</th><th>Total</th><th>Abonado</th><th>Saldo</th><th>Estado</th><th></th>
          </tr></thead>
          <tbody>
            ${
              list.length
                ? list
                    .map(
                      (r) => `
                        <tr>
                          <td><strong>${r.customerName}</strong></td>
                          <td>#${r.orderNumber}</td>
                          <td>${r.date}</td>
                          <td>${formatUsd(r.totalUsd)}</td>
                          <td>${formatUsd(paidAmount(r))}</td>
                          <td><strong>${formatUsd(receivableBalance(r))}</strong></td>
                          <td><span class="status-pill ${r.status === 'paid' ? 'delivered' : r.status === 'partial' ? 'prepared' : 'pending'}">${statusLabels[r.status] || r.status}</span></td>
                          <td>${r.status === 'paid' ? '' : `<button class="primary-button compact" data-abono="${r.id}">Abonar</button>`}</td>
                        </tr>`
                    )
                    .join('')
                : '<tr><td colspan="8" class="muted-cell">Sin cuentas por cobrar. Las ventas a credito apareceran aqui.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </section>
    ${renderAccountModal()}
  `;
}

function renderRates() {
  const charged = state.settings.exchangeRate;
  const bcv = latestRate(state.rateHistory, 'BCV');
  const diff = bcv ? rateDifference(charged.value, bcv.value) : null;
  const rounding = state.settings.bsRounding || { step: 0, mode: 'nearest' };
  const roundingOptions = [
    { value: 0, label: 'Sin redondeo' },
    { value: 1, label: 'A 1 Bs' },
    { value: 5, label: 'A 5 Bs' },
    { value: 10, label: 'A 10 Bs' },
    { value: 100, label: 'A 100 Bs' }
  ];

  return `
    <section class="rates-panel">
      <div class="section-heading">
        <h2>Tasa de cambio</h2>
        <button class="primary-button compact" data-action="fetch-bcv">Actualizar BCV</button>
      </div>

      <div class="dashboard-grid">
        ${metricCard('Tasa cobrada', `${charged.value}`, `${charged.source.toUpperCase()} · ${charged.date}`, 'solid')}
        ${metricCard('Tasa BCV', bcv ? `${bcv.value}` : 'Sin dato', bcv ? bcv.date : 'Actualiza el BCV', '')}
        ${
          diff
            ? metricCard(
                'Diferencia vs BCV',
                `${diff.diffBs > 0 ? '+' : ''}${diff.percent}%`,
                `${diff.diffBs > 0 ? '+' : ''}${diff.diffBs} Bs/$`,
                diff.diffBs ? 'solid' : ''
              )
            : metricCard('Diferencia vs BCV', '—', 'Sin tasa BCV', '')
        }
      </div>

      ${bcvStatus ? `<div class="rate-status">${bcvStatus}</div>` : ''}

      <div class="rates-grid">
        <form class="inventory-form" data-action="apply-rate">
          <h3>Tasa manual</h3>
          <label>Nueva tasa Bs/$
            <input type="number" step="0.01" data-rate-field="value" value="${charged.value}" />
          </label>
          <label>Motivo del cambio (obligatorio)
            <input type="text" data-rate-field="reason" placeholder="Ej: ajuste por tasa paralela" />
          </label>
          <button type="submit" class="primary-button">Aplicar tasa</button>

          <h3 style="margin-top:8px">Redondeo de Bs</h3>
          <label>Redondear total en Bs
            <select data-rounding-field="step">
              ${roundingOptions
                .map(
                  (opt) =>
                    `<option value="${opt.value}" ${Number(rounding.step) === opt.value ? 'selected' : ''}>${opt.label}</option>`
                )
                .join('')}
            </select>
          </label>
          <label>Modo
            <select data-rounding-field="mode">
              ${option2('nearest', 'Mas cercano', rounding.mode)}
              ${option2('up', 'Hacia arriba', rounding.mode)}
              ${option2('down', 'Hacia abajo', rounding.mode)}
            </select>
          </label>
        </form>

        <div class="kardex-wrap">
          <h3>Historial de tasas</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Fecha</th><th>Fuente</th><th>Tasa</th></tr></thead>
              <tbody>
                ${state.rateHistory
                  .slice(0, 12)
                  .map(
                    (rate) =>
                      `<tr><td>${rate.date}</td><td><span class="mode-pill">${rate.source}</span></td><td>${rate.value}</td></tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="movement-list">
        <h3>Auditoria de cambios de tasa</h3>
        ${
          state.rateAudit.length
            ? state.rateAudit
                .slice(0, 12)
                .map(
                  (entry) => `
                    <div class="movement-row">
                      <span>${entry.fromValue} → ${entry.toValue} Bs/$ · ${entry.reason || 'Sin motivo'}${entry.orderNumber ? ` · Pedido #${entry.orderNumber}` : ''}</span>
                      <strong>${entry.at.slice(0, 10)}</strong>
                    </div>`
                )
                .join('')
            : '<div class="empty-cart">Sin cambios de tasa registrados</div>'
        }
      </div>
    </section>
  `;
}

function option2(value, label, selected) {
  return `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`;
}

async function fetchBcvRate() {
  bcvStatus = 'Consultando tasa BCV...';
  render();
  try {
    const res = await fetch('https://ve.dolarapi.com/v1/dolares/oficial', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const value = Number(data.promedio);
    if (!value) throw new Error('Respuesta sin tasa');
    const today = new Date().toISOString().slice(0, 10);
    setState(() => {
      state.rateHistory = recordRate(state.rateHistory, { value, source: 'BCV', date: today });
    });
    bcvStatus = `BCV actualizado: ${value} Bs/$ (${today}). Aplica la tasa manual si deseas cobrar con ella.`;
    render();
  } catch (error) {
    bcvStatus = `No se pudo consultar el BCV (${error.message}). Ingresa la tasa manualmente.`;
    render();
  }
}

function applyManualRate() {
  const valueInput = document.querySelector('[data-rate-field="value"]');
  const reasonInput = document.querySelector('[data-rate-field="reason"]');
  const value = Number(valueInput.value);
  const reason = reasonInput.value;
  const prev = state.settings.exchangeRate.value;

  if (!value || value <= 0) {
    bcvStatus = 'Ingresa una tasa valida.';
    render();
    return;
  }
  if (rateChanged(prev, value) && !reason.trim()) {
    bcvStatus = 'Debes indicar el motivo del cambio de tasa.';
    render();
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  setState(() => {
    if (rateChanged(prev, value)) {
      state.rateAudit = [
        createRateAuditEntry({ fromValue: prev, toValue: value, source: 'manual', reason }),
        ...state.rateAudit
      ];
    }
    state.rateHistory = recordRate(state.rateHistory, { value, source: 'manual', date: today });
    state.settings.exchangeRate = { value: roundMoney(value), source: 'manual', date: today };
    currentOrder = { ...currentOrder, exchangeRate: state.settings.exchangeRate };
  });
  bcvStatus = `Tasa aplicada: ${roundMoney(value)} Bs/$`;
  render();
}

function setRounding(field, value) {
  setState(() => {
    state.settings.bsRounding = {
      ...(state.settings.bsRounding || { step: 0, mode: 'nearest' }),
      [field]: field === 'step' ? Number(value) : value
    };
  });
}

function renderGalpon() {
  return `
    <section class="galpon-panel">
      <div class="section-heading">
        <h2>Operacion galpon</h2>
        <p>Controla lo que debes preparar/comprar sin tocar inventario propio.</p>
      </div>
      <div class="supplier-list">
        ${
          state.supplierOrders.length
            ? state.supplierOrders.map(renderSupplierOrder).join('')
            : '<div class="empty-cart">Finaliza una venta bajo pedido para crear orden al galpon</div>'
        }
      </div>
    </section>
  `;
}

function renderSupplierOrder(order) {
  const margin = calculateSupplierOrderMargin(order);
  return `
    <article class="supplier-order">
      <div class="supplier-head">
        <div>
          <span class="sku">Pedido cliente #${order.saleOrderNumber}</span>
          <h3>${order.supplierName}</h3>
        </div>
        <span class="status-pill ${order.status}">${statusLabel(order.status)}</span>
      </div>
      <div class="supplier-lines">
        ${order.items
          .map(
            (item) => `
              <div class="supplier-line">
                <div>
                  <strong>${item.name}</strong>
                  <small>Solicitado: ${item.requestedQuantity} ${item.unit} · Venta ${formatUsd(item.saleUnitPriceUsd)}/${item.unit}</small>
                </div>
                <label>Real
                  <input type="number" step="0.1" value="${item.actualQuantity}" data-supplier-qty="${order.id}|${item.saleItemId}" />
                </label>
                <label>Costo real
                  <input type="number" step="0.01" value="${item.actualUnitCostUsd}" data-supplier-cost="${order.id}|${item.saleItemId}" />
                </label>
              </div>
            `
          )
          .join('')}
      </div>
      <div class="supplier-summary">
        <div><span>Venta</span><strong>${formatUsd(margin.revenueUsd)}</strong></div>
        <div><span>Costo estimado</span><strong>${formatUsd(margin.estimatedCostUsd)}</strong></div>
        <div><span>Costo real</span><strong>${formatUsd(margin.actualCostUsd)}</strong></div>
        <div><span>Margen real</span><strong>${formatUsd(margin.realMarginUsd)}</strong></div>
      </div>
      <div class="supplier-actions">
        ${nextStatusButton(order)}
      </div>
    </article>
  `;
}

function statusLabel(status) {
  return {
    pending: 'Pendiente',
    prepared: 'Preparado',
    picked_up: 'Retirado',
    delivered: 'Despachado',
    cancelled: 'Cancelada'
  }[status];
}

function nextStatusButton(order) {
  const next = {
    pending: ['prepared', 'Marcar preparado'],
    prepared: ['picked_up', 'Marcar retirado'],
    picked_up: ['delivered', 'Marcar despachado']
  }[order.status];

  if (!next) return '<span class="done-label">Orden cerrada</span>';
  return `<button class="primary-button compact" data-supplier-next="${order.id}|${next[0]}">${next[1]}</button>`;
}

function renderAccounts() {
  const totals = totalsByCurrency(state.accounts);
  const rate = state.settings.exchangeRate.value;
  return `
    <section class="accounts-panel">
      <div class="section-heading">
        <h2>Cuentas y caja</h2>
        <p>Los pagos finalizados alimentan balances y movimientos.</p>
      </div>
      <div class="account-actions">
        <button class="primary-button compact" data-acct-action="transfer">Transferir entre cuentas</button>
        <button class="ghost-button compact" data-acct-action="deposit">+ Ingresar saldo</button>
        <button class="ghost-button compact" data-acct-action="withdraw">- Retirar saldo</button>
        <button class="ghost-button compact" data-acct-action="new-account">+ Nueva cuenta</button>
        <button class="ghost-button compact" data-acct-action="new-method">+ Nuevo metodo de pago</button>
        <div class="account-totals">
          <strong>Total USD ${formatUsd(totals.USD || 0)}</strong>
          <strong>Total Bs ${formatVes(totals.VES || 0)}</strong>
        </div>
      </div>
      <div class="account-grid">
        ${state.accounts.map((account) => renderAccountCard(account, rate)).join('')}
      </div>
      <div class="movement-list">
        <h3>Movimientos recientes</h3>
        ${
          state.accountMovements.length
            ? state.accountMovements
                .slice(0, 12)
                .map(
                  (movement) => `
                    <div class="movement-row">
                      <span>${movement.note}</span>
                      <strong class="${movement.amount < 0 ? 'neg-cell' : 'pos-cell'}">${movement.currency === 'VES' ? formatVes(movement.amount) : formatUsd(movement.amount)}</strong>
                    </div>
                  `
                )
                .join('')
            : '<div class="empty-cart">Aun no hay movimientos de caja</div>'
        }
      </div>
    </section>
    ${renderAccountModal()}
  `;
}

function renderAccountCard(account, rate) {
  const methods = state.paymentMethods.filter((m) => m.accountId === account.id);
  const equiv =
    account.currency === 'VES' && rate
      ? `<small class="usd-eq">(${formatUsd(account.balance / rate)})</small>`
      : '';
  return `
    <article class="account-card">
      <span>${account.currency}</span>
      <strong>${account.name}</strong>
      <b>${account.currency === 'USD' ? formatUsd(account.balance) : formatVes(account.balance)} ${equiv}</b>
      <div class="acct-methods">
        ${
          methods.length
            ? methods.map((m) => `<span class="method-pill">${m.name}</span>`).join('')
            : '<span class="method-pill empty">Sin metodos</span>'
        }
      </div>
    </article>
  `;
}

function renderAccountModal() {
  if (!accountModal) return '';
  const m = accountModal;
  const accountOptions = (selectedId) =>
    state.accounts
      .map((a) => `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${a.name} (${a.currency})</option>`)
      .join('');

  let title = '';
  let body = '';

  if (m.type === 'transfer') {
    const from = state.accounts.find((a) => a.id === m.fromId) || state.accounts[0];
    const to = state.accounts.find((a) => a.id === m.toId) || state.accounts.find((a) => a.id !== from.id);
    const cross = from && to && from.currency !== to.currency;
    title = 'Transferir entre cuentas';
    body = `
      <label>Desde
        <select data-modal-select="fromId">${accountOptions(from?.id)}</select>
      </label>
      <label>Hacia
        <select data-modal-select="toId">${accountOptions(to?.id)}</select>
      </label>
      <label>Monto (${from?.currency || ''})
        <input type="number" step="0.01" data-modal-field="amount" id="m-amount" value="${m.amount || ''}" />
      </label>
      ${
        cross
          ? `<label>Tasa del cambio (Bs/$)
              <input type="number" step="0.01" data-modal-field="rate" id="m-rate" value="${m.rate ?? state.settings.exchangeRate.value}" />
            </label>
            <div class="modal-preview">Recibe en ${to.name}: <strong id="transfer-preview">—</strong></div>`
          : ''
      }
      <label>Nota (opcional)
        <input type="text" data-modal-field="note" value="${m.note || ''}" />
      </label>
    `;
  } else if (m.type === 'deposit' || m.type === 'withdraw') {
    title = m.type === 'deposit' ? 'Ingresar saldo' : 'Retirar saldo';
    body = `
      <label>Cuenta
        <select data-modal-select="accountId">${accountOptions(m.accountId)}</select>
      </label>
      <label>Monto
        <input type="number" step="0.01" data-modal-field="amount" value="${m.amount || ''}" />
      </label>
      <label>Nota
        <input type="text" data-modal-field="note" value="${m.note || ''}" placeholder="${m.type === 'deposit' ? 'Ingreso de capital...' : 'Retiro de caja...'}" />
      </label>
    `;
  } else if (m.type === 'new-account') {
    title = 'Nueva cuenta';
    body = `
      <label>Nombre
        <input type="text" data-modal-field="name" value="${m.name || ''}" placeholder="Ej: Mercantil" />
      </label>
      <label>Moneda
        <select data-modal-select="currency">
          ${option2('USD', 'USD ($)', m.currency || 'USD')}
          ${option2('VES', 'Bolivares (Bs)', m.currency || 'USD')}
        </select>
      </label>
      <label>Saldo inicial
        <input type="number" step="0.01" data-modal-field="balance" value="${m.balance || ''}" />
      </label>
    `;
  } else if (m.type === 'new-method') {
    title = 'Nuevo metodo de pago';
    body = `
      <label>Nombre del metodo
        <input type="text" data-modal-field="name" value="${m.name || ''}" placeholder="Ej: Pago Movil Mercantil" />
      </label>
      <label>Cuenta asociada
        <select data-modal-select="accountId">${accountOptions(m.accountId)}</select>
      </label>
    `;
  } else if (m.type === 'abono') {
    const receivable = state.receivables.find((r) => r.id === m.receivableId);
    const balance = receivable ? receivableBalance(receivable) : 0;
    title = `Abonar a ${receivable?.customerName || ''}`;
    body = `
      <div class="modal-preview">Saldo pendiente: <strong>${formatUsd(balance)}</strong></div>
      <label>Monto del abono (USD)
        <input type="number" step="0.01" data-modal-field="amount" value="${m.amount ?? balance}" />
      </label>
      <label>Entra a la cuenta
        <select data-modal-select="accountId">${accountOptions(m.accountId)}</select>
      </label>
      <label>Nota
        <input type="text" data-modal-field="note" value="${m.note || ''}" placeholder="Abono / referencia..." />
      </label>
    `;
  }

  return `
    <div class="modal-overlay" data-action="close-modal">
      <div class="modal" data-modal-stop>
        <div class="modal-head"><h3>${title}</h3><button class="modal-close" data-action="close-modal">x</button></div>
        <form class="modal-form" data-action="submit-modal">
          ${body}
          <div class="modal-actions">
            <button type="button" class="ghost-button compact" data-action="close-modal">Cancelar</button>
            <button type="submit" class="primary-button compact">Confirmar</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function openAccountModal(type) {
  const first = state.accounts[0];
  const second = state.accounts.find((a) => a.id !== first.id) || first;
  if (type === 'transfer') {
    accountModal = { type, fromId: first.id, toId: second.id, amount: '', rate: state.settings.exchangeRate.value, note: '' };
  } else if (type === 'deposit' || type === 'withdraw') {
    accountModal = { type, accountId: first.id, amount: '', note: '' };
  } else if (type === 'new-account') {
    accountModal = { type, name: '', currency: 'USD', balance: '' };
  } else if (type === 'new-method') {
    accountModal = { type, name: '', accountId: first.id };
  }
  render();
}

function closeAccountModal() {
  accountModal = null;
  render();
}

function readModalFields() {
  if (!accountModal) return;
  document.querySelectorAll('[data-modal-field]').forEach((input) => {
    accountModal[input.dataset.modalField] = input.value;
  });
}

function submitAccountModal() {
  readModalFields();
  const m = accountModal;
  if (!m) return;

  if (m.type === 'transfer') {
    const from = state.accounts.find((a) => a.id === m.fromId);
    const to = state.accounts.find((a) => a.id === m.toId);
    const amount = Number(m.amount);
    if (!from || !to || from.id === to.id || !amount || amount <= 0) {
      window.alert('Selecciona dos cuentas distintas y un monto valido.');
      return;
    }
    const cross = from.currency !== to.currency;
    const rate = Number(m.rate);
    if (cross && (!rate || rate <= 0)) {
      window.alert('Indica la tasa del cambio para la transferencia entre monedas.');
      return;
    }
    const movements = createTransferMovements({ fromAccount: from, toAccount: to, amount, rate: cross ? rate : null, note: m.note });
    setState(() => {
      state.accountMovements = [...movements, ...state.accountMovements];
      state.accounts = applyMovements(state.accounts, movements);
    });
  } else if (m.type === 'deposit' || m.type === 'withdraw') {
    const account = state.accounts.find((a) => a.id === m.accountId);
    const amount = Number(m.amount);
    if (!account || !amount || amount <= 0) {
      window.alert('Selecciona la cuenta y un monto valido.');
      return;
    }
    const signed = m.type === 'deposit' ? amount : -amount;
    const movement = createAdjustmentMovement({
      accountId: account.id,
      amount: signed,
      currency: account.currency,
      note: (m.note || '').trim() || (m.type === 'deposit' ? 'Ingreso de saldo' : 'Retiro de saldo')
    });
    setState(() => {
      state.accountMovements = [movement, ...state.accountMovements];
      state.accounts = applyMovements(state.accounts, [movement]);
    });
  } else if (m.type === 'new-account') {
    if (!(m.name || '').trim()) {
      window.alert('Indica el nombre de la cuenta.');
      return;
    }
    const account = createAccount({ name: m.name, currency: m.currency, balance: m.balance });
    setState(() => {
      state.accounts = [...state.accounts, account];
    });
  } else if (m.type === 'new-method') {
    const account = state.accounts.find((a) => a.id === m.accountId);
    if (!(m.name || '').trim() || !account) {
      window.alert('Indica el nombre y la cuenta asociada.');
      return;
    }
    const method = createPaymentMethod({ name: m.name, account });
    setState(() => {
      state.paymentMethods = [...state.paymentMethods, method];
    });
  } else if (m.type === 'abono') {
    const receivable = state.receivables.find((r) => r.id === m.receivableId);
    const account = state.accounts.find((a) => a.id === m.accountId);
    const amount = Number(m.amount);
    if (!receivable || !account || !amount || amount <= 0) {
      window.alert('Selecciona la cuenta y un monto valido.');
      return;
    }
    const movementAmount = account.currency === 'VES' ? applyBsRounding(amount * state.settings.exchangeRate.value, state.settings.bsRounding) : roundMoney(amount);
    setState(() => {
      const { receivable: updated } = addAbono(receivable, { amountUsd: amount, methodName: account.name, note: m.note });
      state.receivables = state.receivables.map((r) => (r.id === receivable.id ? updated : r));
      const movement = createAdjustmentMovement({
        accountId: account.id,
        amount: movementAmount,
        currency: account.currency === 'VES' ? 'VES' : 'USD',
        note: `Abono credito #${receivable.orderNumber} · ${receivable.customerName}`
      });
      state.accountMovements = [movement, ...state.accountMovements];
      state.accounts = applyMovements(state.accounts, [movement]);
    });
  }
  accountModal = null;
  render();
}

function bindAccountModal() {
  document.querySelectorAll('[data-acct-action]').forEach((button) => {
    button.addEventListener('click', () => openAccountModal(button.dataset.acctAction));
  });
  document.querySelectorAll('[data-abono]').forEach((button) => {
    button.addEventListener('click', () => {
      accountModal = { type: 'abono', receivableId: button.dataset.abono, accountId: state.accounts[0].id, amount: '', note: '' };
      render();
    });
  });
  if (!accountModal) return;
  document.querySelectorAll('[data-action="close-modal"]').forEach((el) => {
    el.addEventListener('click', closeAccountModal);
  });
  document.querySelector('[data-modal-stop]')?.addEventListener('click', (event) => event.stopPropagation());
  document.querySelectorAll('[data-modal-select]').forEach((select) => {
    select.addEventListener('change', () => {
      readModalFields();
      accountModal = { ...accountModal, [select.dataset.modalSelect]: select.value };
      render();
    });
  });
  document.querySelector('[data-action="submit-modal"]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAccountModal();
  });
  // Vista previa de conversion en transferencia cross-moneda
  const out = document.querySelector('#transfer-preview');
  if (out) {
    const amt = document.querySelector('#m-amount');
    const rt = document.querySelector('#m-rate');
    const from = state.accounts.find((a) => a.id === accountModal.fromId);
    const to = state.accounts.find((a) => a.id === accountModal.toId);
    const update = () => {
      const value = convertAmount(Number(amt?.value || 0), from.currency, to.currency, Number(rt?.value || 0));
      out.textContent = to.currency === 'VES' ? formatVes(value) : formatUsd(value);
    };
    amt?.addEventListener('input', update);
    rt?.addEventListener('input', update);
    update();
  }
}

function bindEvents() {
  bindAccountModal();
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      activeView = button.dataset.view;
      render();
    });
  });

  document.querySelectorAll('[data-product-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const product = state.products.find((item) => item.id === button.dataset.productId);
      const priced = { ...product, priceUsd: productPrice(product, currentOrder.channel) };
      currentOrder = addItemToOrder(currentOrder, priced, 1);
      render();
    });
  });

  document.querySelectorAll('[data-item-qty]').forEach((input) => {
    input.addEventListener('input', () => {
      currentOrder = updateOrderItemQuantity(currentOrder, input.dataset.itemQty, input.value);
      render();
    });
  });

  document.querySelectorAll('[data-remove-item]').forEach((button) => {
    button.addEventListener('click', () => {
      currentOrder = removeOrderItem(currentOrder, button.dataset.removeItem);
      render();
    });
  });

  document.querySelectorAll('[data-payment-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedPaymentMethod = button.dataset.paymentId;
      render();
    });
  });

  document.querySelector('[data-field="search"]')?.addEventListener('input', (event) => {
    search = event.target.value;
    render();
  });

  document.querySelector('[data-field="customer-search"]')?.addEventListener('input', (event) => {
    customerSearch = event.target.value;
    render();
  });

  document.querySelector('[data-field="order-customer"]')?.addEventListener('input', (event) => {
    customerQuery = event.target.value;
    render();
  });
  document.querySelectorAll('[data-customer-pick]').forEach((button) => {
    button.addEventListener('click', () => {
      const customer = state.customers.find((c) => c.id === button.dataset.customerPick);
      if (customer) {
        currentOrder = { ...currentOrder, customerId: customer.id, customerName: customer.name };
        customerQuery = '';
        render();
      }
    });
  });
  document.querySelector('[data-action="clear-customer"]')?.addEventListener('click', () => {
    currentOrder = { ...currentOrder, customerId: null, customerName: '' };
    customerQuery = '';
    render();
  });
  document.querySelectorAll('[data-pay-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      paymentMode = button.dataset.payMode;
      render();
    });
  });

  document.querySelectorAll('[data-field]').forEach((field) => {
    field.addEventListener('change', handleFieldChange);
    if (['customer', 'notes'].includes(field.dataset.field)) {
      field.addEventListener('input', handleFieldChange);
    }
  });

  document.querySelector('[data-action="toggle-currency"]')?.addEventListener('click', () => {
    setState(() => {
      state.settings.currencyView = state.settings.currencyView === 'USD' ? 'VES' : 'USD';
    });
  });

  document.querySelector('[data-action="finalize"]')?.addEventListener('click', finalizeCurrentOrder);
  document.querySelector('[data-action="download-quote"]')?.addEventListener('click', downloadQuote);
  document.querySelector('[data-action="reset-storage"]')?.addEventListener('click', () => {
    localStorage.clear();
    location.reload();
  });

  document.querySelectorAll('[data-supplier-next]').forEach((button) => {
    button.addEventListener('click', () => {
      const [orderId, nextStatus] = button.dataset.supplierNext.split('|');
      setState(() => {
        state.supplierOrders = state.supplierOrders.map((order) =>
          order.id === orderId ? advanceSupplierOrderStatus(order, nextStatus) : order
        );
      });
    });
  });

  document.querySelectorAll('[data-supplier-qty], [data-supplier-cost]').forEach((input) => {
    input.addEventListener('change', handleSupplierActualChange);
  });

  document.querySelectorAll('[data-inv-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      inventoryForm = { ...inventoryForm, mode: button.dataset.invMode };
      render();
    });
  });

  document.querySelectorAll('[data-inv-field]').forEach((field) => {
    field.addEventListener('input', () => {
      inventoryForm = { ...inventoryForm, [field.dataset.invField]: field.value };
      if (field.dataset.invField === 'productId') render();
    });
  });

  document.querySelector('[data-action="inventory-submit"]')?.addEventListener('submit', handleInventorySubmit);

  document.querySelectorAll('[data-export-csv]').forEach((button) => {
    button.addEventListener('click', () => exportReportCsv(button.dataset.exportCsv));
  });
  document.querySelector('[data-action="print-report"]')?.addEventListener('click', printReport);

  document.querySelectorAll('[data-doc]').forEach((button) => {
    button.addEventListener('click', () => {
      const [type, orderId] = button.dataset.doc.split('|');
      generateDocument(type, orderId);
    });
  });
  document.querySelectorAll('[data-thermal]').forEach((button) => {
    button.addEventListener('click', () => thermalPrint(button.dataset.thermal));
  });
  document.querySelectorAll('[data-wa]').forEach((button) => {
    button.addEventListener('click', () => whatsappOrder(button.dataset.wa));
  });
  document.querySelectorAll('[data-annul]').forEach((button) => {
    button.addEventListener('click', () => annulOrderById(button.dataset.annul));
  });
  document.querySelectorAll('[data-reprint]').forEach((button) => {
    button.addEventListener('click', () => reprintDocument(button.dataset.reprint));
  });

  document.querySelector('[data-action="fetch-bcv"]')?.addEventListener('click', fetchBcvRate);
  document.querySelector('[data-action="apply-rate"]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    applyManualRate();
  });
  document.querySelectorAll('[data-rounding-field]').forEach((select) => {
    select.addEventListener('change', () => setRounding(select.dataset.roundingField, select.value));
  });

  document.querySelector('[data-import-file]')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) runInvoiceOcr(file);
  });
  document.querySelector('[data-action="parse-text"]')?.addEventListener('click', parseImportText);
  document.querySelector('[data-action="apply-margin-all"]')?.addEventListener('click', applyMarginToAll);
  document.querySelector('[data-action="add-row"]')?.addEventListener('click', addImportRow);
  document.querySelector('[data-action="load-order"]')?.addEventListener('click', () => loadImportToOrder(false));
  document.querySelector('[data-action="import-quote"]')?.addEventListener('click', () => loadImportToOrder(true));
  document.querySelectorAll('[data-row]').forEach((input) => {
    input.addEventListener('input', () => {
      const [index, field] = input.dataset.row.split('|');
      updateImportRow(Number(index), field, input.value);
    });
  });
  document.querySelectorAll('[data-remove-row]').forEach((button) => {
    button.addEventListener('click', () => {
      importState.rows = importState.rows.filter((_, i) => i !== Number(button.dataset.removeRow));
      render();
    });
  });
  document.querySelectorAll('[data-add-catalog]').forEach((button) => {
    button.addEventListener('click', () => addRowToCatalog(Number(button.dataset.addCatalog)));
  });
}

function handleInventorySubmit(event) {
  event.preventDefault();
  const product = state.products.find((item) => item.id === inventoryForm.productId);
  if (!product) return;

  const movement =
    inventoryForm.mode === 'purchase'
      ? createPurchaseMovement({
          product,
          quantity: inventoryForm.quantity,
          unitCostUsd: inventoryForm.unitCostUsd === '' ? product.estimatedCostUsd : inventoryForm.unitCostUsd,
          note: inventoryForm.note
        })
      : createInventoryAdjustment({ product, quantity: inventoryForm.quantity, note: inventoryForm.note });

  if (!movement.quantity) return;

  setState(() => {
    state.inventoryMovements = [movement, ...state.inventoryMovements];
    state.products = applyInventoryMovements(state.products, [movement]);
  });
  inventoryForm = { mode: inventoryForm.mode, productId: '', quantity: '', unitCostUsd: '', note: '' };
  render();
}

function handleFieldChange(event) {
  const field = event.target.dataset.field;
  if (!field) return;

  if (field === 'search' || field === 'customer-search') return;
  if (field === 'channel') currentOrder = { ...currentOrder, channel: event.target.value };
  if (field === 'location') currentOrder = { ...currentOrder, location: event.target.value };
  if (field === 'customer') currentOrder = { ...currentOrder, customerName: event.target.value };
  if (field === 'notes') currentOrder = { ...currentOrder, notes: event.target.value };
  if (field === 'iva') currentOrder = { ...currentOrder, applyIva: event.target.checked };
  if (field === 'igtf') currentOrder = { ...currentOrder, applyIgtf: event.target.checked };
  if (field === 'rate') {
    const value = Number(event.target.value);
    const prev = currentOrder.exchangeRate.value;
    if (!value || value <= 0) {
      render();
      return;
    }
    if (rateChanged(prev, value)) {
      const reason = window.prompt('Motivo del cambio de tasa para este pedido (obligatorio):', '');
      if (reason === null || !reason.trim()) {
        render(); // descarta el cambio: currentOrder no se modifico
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      state.rateAudit = [
        createRateAuditEntry({
          fromValue: prev,
          toValue: value,
          source: 'manual',
          reason,
          orderNumber: currentOrder.orderNumber
        }),
        ...state.rateAudit
      ];
      state.rateHistory = recordRate(state.rateHistory, { value, source: 'manual', date: today });
      currentOrder = {
        ...currentOrder,
        exchangeRate: { value: roundMoney(value), source: 'manual', date: today }
      };
      state.settings.exchangeRate = currentOrder.exchangeRate;
    }
    persistState(state);
    render();
    return;
  }
  persistState(state);
  render();
}

function finalizeCurrentOrder() {
  const isCredit = paymentMode === 'credito';
  if (isCredit && !currentOrder.customerId) {
    window.alert('Selecciona un cliente del sistema para registrar el credito.');
    return;
  }

  const totals = calculateOrderTotals(currentOrder);
  const method = isCredit
    ? { id: 'credito', name: 'Credito', currency: 'USD', accountId: null }
    : state.paymentMethods.find((item) => item.id === selectedPaymentMethod);

  const paid = finalizeOrder(currentOrder, {
    methodId: method.id,
    methodName: method.name,
    amountUsd: totals.totalUsd,
    reference: '',
    credit: isCredit
  });
  // Aplica el redondeo configurable de Bs al monto cobrado y al total del documento.
  const roundedVes = applyBsRounding(paid.payment.amountVes, state.settings.bsRounding);
  paid.payment.amountVes = roundedVes;
  paid.totals.totalVes = roundedVes;

  setState(() => {
    const generatedSupplierOrders = createSupplierOrdersFromSale(paid);
    const inventoryMovements = createSaleMovementsFromSale(paid);
    state.orders = [paid, ...state.orders];
    state.supplierOrders = [...generatedSupplierOrders, ...state.supplierOrders];
    state.inventoryMovements = [...inventoryMovements, ...state.inventoryMovements];
    state.products = applyInventoryMovements(state.products, inventoryMovements);

    if (isCredit) {
      // Venta a credito: no entra dinero todavia, se crea la cuenta por cobrar.
      const customer = state.customers.find((c) => c.id === currentOrder.customerId);
      state.receivables = [createReceivable({ order: paid, customer }), ...state.receivables];
    } else {
      const accountAmount = method.currency === 'VES' ? roundedVes : paid.payment.amountUsd;
      const paymentMovement = createPaymentMovement({
        accountId: method.accountId,
        orderId: paid.id,
        orderNumber: paid.orderNumber,
        amount: accountAmount,
        currency: method.currency === 'VES' ? 'VES' : 'USD',
        methodName: method.name
      });
      state.accountMovements = [paymentMovement, ...state.accountMovements];
      state.accounts = applyMovements(state.accounts, [paymentMovement]);
    }

    currentOrder = createOrderDraft({
      orderNumber: nextOrderNumber(),
      exchangeRate: state.settings.exchangeRate,
      channel: currentOrder.channel,
      location: currentOrder.location
    });
    customerQuery = '';
    paymentMode = 'contado';
  });
}

function handleSupplierActualChange(event) {
  const key = event.target.dataset.supplierQty || event.target.dataset.supplierCost;
  const [orderId, saleItemId] = key.split('|');
  setState(() => {
    state.supplierOrders = state.supplierOrders.map((order) => {
      if (order.id !== orderId) return order;
      const item = order.items.find((line) => line.saleItemId === saleItemId);
      return updateSupplierOrderActuals(order, saleItemId, {
        actualQuantity:
          event.target.dataset.supplierQty !== undefined ? event.target.value : item.actualQuantity,
        actualUnitCostUsd:
          event.target.dataset.supplierCost !== undefined
            ? event.target.value
            : item.actualUnitCostUsd
      });
    });
  });
}

function downloadQuote() {
  if (!currentOrder.items.length) return;
  const source = { ...currentOrder, totals: calculateOrderTotals(currentOrder) };
  const number = nextDocumentNumber(state.documents, 'cotizacion');
  const doc = createDocument({ order: source, type: 'cotizacion', number });
  setState(() => {
    state.documents = [doc, ...state.documents];
  });
  openPrintWindow(documentHtml(doc), `${doc.label} ${doc.number}`);
}

render();
