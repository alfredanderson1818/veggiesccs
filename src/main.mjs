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
import { createReceivable, addAbono, receivableBalance, paidAmount, receivablesSummary, isOverdue } from './domain/receivables.mjs';
import {
  createPayable,
  addPago,
  payableBalance,
  paidAmount as payablePaidAmount,
  payablesSummary,
  isOverdue as isPayableOverdue
} from './domain/payables.mjs';
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
import { loadInitialState, persistState, serializeState, hydrateState, STATE_KEYS } from './state/appState.mjs';
import { PM_PRODUCTS, PM_PAYABLES } from './data/pmProducts.mjs';
import { normalizePhoneVE, fillTemplate, waLink, DEFAULT_TEMPLATES } from './domain/messaging.mjs';
import { findSupplierMatch, createSupplier } from './domain/suppliers.mjs';
import { supabase } from './supabase/client.mjs';
import {
  getClientId,
  getSyncedAt,
  setSyncedAt,
  isNewer,
  pullRemoteState,
  pushRemoteState,
  subscribeRemoteState
} from './state/cloudSync.mjs';

const root = document.querySelector('#root');
const state = loadInitialState();
let activeView = 'pos';
let search = '';
let selectedPaymentMethod = state.paymentMethods[0].id;
let inventoryForm = { mode: 'purchase', productId: '', quantity: '', unitCostUsd: '', note: '' };
let bcvStatus = '';
let importState = { rawText: '', rows: [], status: '', marginPct: Number(state.settings.importMarginPct ?? 30), busy: false };
let customerSearch = '';
let accountModal = null;
let customerQuery = '';
let paymentMode = 'contado'; // 'contado' | 'mixto' | 'credito'
let mixedAmounts = {}; // { [methodId]: montoUsdString } para pago mixto
// Vencimiento del credito: por defecto a N dias (configurable en Configuracion).
function defaultCreditDue() {
  const days = Math.max(0, Number(state.settings.creditDays ?? 7));
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
let creditDueDate = defaultCreditDue();
let selectedAccountId = null;
let webOrders = [];
let webOrdersStatus = '';
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
  scheduleCloudPush();
  render();
}

// ---- Sincronizacion en la nube ----
// Version = updated_at del servidor (reloj monotono => convergencia determinista).
let cloudPushTimer = null;
let cloudSyncing = false; // true mientras adopto un estado remoto (evita re-subirlo)
let cloudReady = false; // true tras el primer pull/push del arranque
let cloudDirty = false; // hay cambios locales aun sin subir

// Estado visible de la nube (chip en el sidebar + detalle en Configuracion).
let cloudStatus = { state: 'starting', detail: '' }; // starting | ok | local | error

function setCloudStatus(stateKey, detail) {
  cloudStatus = { state: stateKey, detail: detail || '' };
  const el = document.querySelector('[data-sync-chip]');
  if (el) el.outerHTML = syncChipHtml();
}

function syncChipHtml() {
  const time = getSyncedAt()
    ? new Date(getSyncedAt()).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })
    : '';
  const map = {
    starting: ['', '☁ Conectando...'],
    ok: ['ok', `☁ Nube sincronizada${time ? ` · ${time}` : ''}`],
    local: ['off', '☁ Solo en este equipo'],
    error: ['err', '☁ Nube con error']
  };
  const [cls, label] = map[cloudStatus.state] || map.starting;
  return `<div class="sync-chip ${cls}" data-sync-chip title="${cloudStatus.detail || 'Estado de la base de datos en la nube'}">${label}</div>`;
}

function scheduleCloudPush() {
  cloudDirty = true; // se registra SIEMPRE, aun antes de cloudReady, para no perderlo
  if (cloudSyncing || !cloudReady) return;
  if (cloudStatus.state === 'local') return; // sin sesion: la nube esta bloqueada, no intentes subir
  if (cloudPushTimer) clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(cloudPushNow, 1200);
}

async function cloudPushNow() {
  if (cloudPushTimer) {
    clearTimeout(cloudPushTimer);
    cloudPushTimer = null;
  }
  cloudDirty = false; // subimos el estado actual; si algo cambia durante el await se remarca
  try {
    const ts = await pushRemoteState(serializeState(state));
    setSyncedAt(ts);
    setCloudStatus('ok');
  } catch (err) {
    cloudDirty = true; // no se subio: sigue pendiente
    setCloudStatus('error', err?.message || String(err));
    console.warn('Sync: no se pudo subir el estado —', err?.message || err);
  }
}

function adoptRemoteState(remote) {
  // Cancela cualquier push pendiente: adoptamos el remoto, no re-subimos lo viejo.
  if (cloudPushTimer) {
    clearTimeout(cloudPushTimer);
    cloudPushTimer = null;
  }
  cloudSyncing = true;
  let migrated = false;
  try {
    hydrateState(state, remote.data);
    setSyncedAt(remote.updatedAt);
    cloudDirty = false;
    // Si el snapshot remoto viene de una version anterior, aplicarle las
    // migraciones (productos PM, registro de proveedores) SOBRE lo adoptado.
    migrated = Boolean(ensurePmData()) || Boolean(ensureSuppliers());
    // Reconciliar estado derivado que pudo quedar apuntando a algo inexistente.
    if (!state.paymentMethods.find((m) => m.id === selectedPaymentMethod)) {
      selectedPaymentMethod = state.paymentMethods[0]?.id ?? null;
    }
    // Recalcular el numero de pedido del borrador contra las ordenes ya adoptadas
    // (evita numeros correlativos duplicados) y refrescar la tasa.
    currentOrder = {
      ...currentOrder,
      orderNumber: nextOrderNumber(),
      exchangeRate: state.settings.exchangeRate
    };
    persistState(state);
    render();
  } finally {
    cloudSyncing = false; // pase lo que pase, el sync no queda bloqueado
  }
  // Migraciones sobre el remoto adoptado: eso si se sube (remoto + delta).
  if (migrated) scheduleCloudPush();
}

async function initCloudSync() {
  try {
    // Sin sesion (p.ej. vista previa) la nube esta bloqueada por seguridad:
    // se trabaja local y el chip lo dice claro, sin intentos que fallen.
    const { data } = await supabase.auth.getSession();
    if (!data?.session) {
      cloudReady = true;
      setCloudStatus('local', 'Inicia sesion para sincronizar con la base de datos.');
      return;
    }
    const remote = await pullRemoteState();
    if (remote && isNewer(remote.updatedAt, getSyncedAt()) && !cloudDirty) {
      // Proteccion de primer arranque: si este equipo NUNCA ha sincronizado y
      // tiene trabajo propio (ventas/creditos/caja), no se pisa en silencio —
      // el usuario decide que version manda.
      const neverSynced = !getSyncedAt();
      const hasLocalWork =
        state.orders.length + state.receivables.length + state.accountMovements.length > 0;
      if (neverSynced && hasLocalWork) {
        const useCloud = window.confirm(
          'En la nube ya hay datos guardados (de otro equipo) y este equipo tambien tiene trabajo que NUNCA se ha sincronizado.\n\n' +
            '¿Usar los datos de la NUBE en este equipo?\n\n' +
            '• Aceptar: usar la NUBE (lo de este equipo se reemplaza).\n' +
            '• Cancelar: conservar lo de ESTE equipo y subirlo (la nube se reemplaza).'
        );
        if (!useCloud) {
          await cloudPushNow();
          cloudReady = true;
          if (cloudDirty) scheduleCloudPush();
          subscribeRemoteState((incoming) => {
            if (incoming.clientId === getClientId()) {
              if (isNewer(incoming.updatedAt, getSyncedAt())) setSyncedAt(incoming.updatedAt);
              return;
            }
            if (isNewer(incoming.updatedAt, getSyncedAt())) adoptRemoteState(incoming);
          });
          return;
        }
      }
      // El remoto es mas nuevo y no edite nada durante el arranque: lo adoptamos.
      adoptRemoteState(remote);
      setCloudStatus('ok');
    } else if (remote && isNewer(remote.updatedAt, getSyncedAt()) && cloudDirty) {
      // Caso raro: el usuario alcanzo a editar mientras la app abria Y la nube
      // tiene una version mas nueva. Nunca se pisa nada en silencio: se pregunta.
      const pushLocal = window.confirm(
        'Hiciste cambios en este equipo mientras la app abria, pero la nube tiene una version mas nueva (de otro equipo).\n\n' +
          '• Aceptar: SUBIR lo de este equipo (la nube se reemplaza).\n' +
          '• Cancelar: usar la NUBE (se pierden los cambios de hace un momento).'
      );
      if (pushLocal) {
        await cloudPushNow();
      } else {
        adoptRemoteState(remote);
        setCloudStatus('ok');
      }
    } else {
      // No hay remoto, o el local es igual/mas nuevo: subimos el local.
      await cloudPushNow();
    }
    cloudReady = true;
    if (cloudDirty) scheduleCloudPush(); // ediciones que quedaron pendientes en el arranque
    // Escuchar cambios de otros dispositivos.
    subscribeRemoteState((incoming) => {
      if (incoming.clientId === getClientId()) {
        // Eco de mi propio cambio: solo alineo la version.
        if (isNewer(incoming.updatedAt, getSyncedAt())) setSyncedAt(incoming.updatedAt);
        return;
      }
      if (isNewer(incoming.updatedAt, getSyncedAt())) adoptRemoteState(incoming);
    });
  } catch (err) {
    cloudReady = true; // seguimos funcionando solo con localStorage
    setCloudStatus('error', err?.message || String(err));
    console.warn('Sync no disponible (se trabaja local) —', err?.message || err);
  }
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
  'data-customer-pick',
  'data-mixed-amount',
  'data-credit-due',
  'data-item-price',
  'data-item-cost',
  'data-set-field',
  'data-edit-field',
  'data-msg-template'
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

const SECTIONS = [
  { key: 'inicio', label: 'Inicio', ic: '🏠', views: [['dashboard', 'Resumen']] },
  { key: 'ventas', label: 'Ventas', ic: '🛒', views: [['pos', 'Punto de venta'], ['weborders', 'Pedidos web'], ['import', 'Importar factura'], ['galpon', 'Galpon'], ['documents', 'Documentos']] },
  { key: 'catalogo', label: 'Catalogo', ic: '🥬', views: [['catalog', 'Productos'], ['inventory', 'Inventario']] },
  { key: 'clientes', label: 'Clientes', ic: '👥', views: [['customers', 'Cartera'], ['messaging', 'Mensajeria']] },
  { key: 'finanzas', label: 'Finanzas', ic: '💵', views: [['accounts', 'Cuentas y caja'], ['receivables', 'Cuentas por cobrar'], ['payables', 'Cuentas por pagar'], ['reports', 'Reportes'], ['rates', 'Tasa BCV']] },
  { key: 'config', label: 'Configuracion', ic: '⚙️', views: [['settings', 'Configuracion']] }
];
const HIDDEN_VIEW_SECTION = { checkout: 'ventas' };

function sectionForView(view) {
  const s = SECTIONS.find((sec) => sec.views.some(([v]) => v === view));
  if (s) return s;
  return SECTIONS.find((sec) => sec.key === HIDDEN_VIEW_SECTION[view]) || SECTIONS[0];
}

function currentViewLabel() {
  for (const sec of SECTIONS) {
    const f = sec.views.find(([v]) => v === activeView);
    if (f) return f[1];
  }
  return activeView === 'checkout' ? 'Pedido' : 'Panel';
}

function renderSidebarNav() {
  const activeKey = sectionForView(activeView).key;
  return SECTIONS.map(
    (sec) => `
      <button class="nav-section ${sec.key === activeKey ? 'active' : ''}" data-section="${sec.key}">
        <span class="nav-ic">${sec.ic}</span><span class="nav-label">${sec.label}</span>
      </button>`
  ).join('');
}

function renderSubtabs() {
  const sec = sectionForView(activeView);
  if (!sec || sec.views.length < 2 || activeView === 'checkout') return '';
  return `<div class="subtabs">${sec.views
    .map(([v, label]) => `<button class="subtab ${v === activeView ? 'active' : ''}" data-view="${v}">${label}</button>`)
    .join('')}</div>`;
}

function render() {
  const focusSnapshot = captureFocus();
  const totals = calculateOrderTotals(currentOrder);
  const metrics = dashboardMetrics();
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand-mark">
          <img src="/src/assets/logo-veggies.png" alt="Veggies CCS" class="brand-logo" />
        </div>
        <p class="eyebrow">Modulos</p>
        ${renderSidebarNav()}
        <div class="sidebar-footer">
          ${syncChipHtml()}
          <button class="ghost-button" data-action="reset-storage">Restablecer este equipo</button>
          <button class="ghost-button" data-action="logout">Cerrar sesion</button>
          <small>Registrado como:<br><strong>${state.settings.userName}</strong></small>
        </div>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">${sectionForView(activeView).label}</p>
            <h1>${currentViewLabel()}</h1>
          </div>
          <div class="top-actions">
            <button class="primary-button" data-view="pos">+ Nueva venta</button>
          </div>
        </header>
        ${renderSubtabs()}
        ${activeView === 'dashboard' ? renderDashboard(metrics) + renderHome() : ''}
        ${activeView === 'checkout' ? renderCheckout(totals) : ''}
        ${activeView === 'pos' ? renderPos(totals) : ''}
        ${activeView === 'weborders' ? renderWebOrders() : ''}
        ${activeView === 'import' ? renderImport() : ''}
        ${activeView === 'galpon' ? renderGalpon() : ''}
        ${activeView === 'catalog' ? renderCatalog() : ''}
        ${activeView === 'inventory' ? renderInventory() : ''}
        ${activeView === 'reports' ? renderReports() : ''}
        ${activeView === 'rates' ? renderRates() : ''}
        ${activeView === 'documents' ? renderDocuments() : ''}
        ${activeView === 'customers' ? renderCustomers() : ''}
        ${activeView === 'messaging' ? renderMessaging() : ''}
        ${activeView === 'receivables' ? renderReceivables() : ''}
        ${activeView === 'payables' ? renderPayables() : ''}
        ${activeView === 'accounts' ? renderAccounts() : ''}
        ${activeView === 'settings' ? renderSettings() : ''}
        ${renderEditModal()}
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
  const canFinalize = canFinalizeOrder(totals);
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
      ${renderTotalsBox(totals)}
      ${renderPayModeTabs()}
      ${renderPaymentBody(totals)}
      <button class="finish-button" data-action="finalize" ${canFinalize ? '' : 'disabled'}>
        ${finalizeLabel(totals)}
      </button>
      <button class="expand-button" data-view="checkout" ${currentOrder.items.length ? '' : 'disabled'}>Ver pedido en pantalla completa</button>
      <button class="quote-button" data-action="download-quote" ${currentOrder.items.length ? '' : 'disabled'}>Descargar cotizacion</button>
    </aside>
  `;
}

function renderCheckout(totals) {
  const canFinalize = canFinalizeOrder(totals);
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
                <th>Producto</th><th>Modo</th><th>Cantidad</th><th>Costo U.</th><th>Precio U.</th><th>Total</th><th></th>
              </tr></thead>
              <tbody>
                ${
                  currentOrder.items.length
                    ? currentOrder.items.map(renderCheckoutRow).join('')
                    : '<tr><td colspan="7" class="muted-cell">Sin productos. Agregalos desde el catalogo o Importar.</td></tr>'
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
          ${renderTotalsBox(totals)}
          ${renderPayModeTabs()}
          ${renderPaymentBody(totals)}
          <button class="finish-button" data-action="finalize" ${canFinalize ? '' : 'disabled'}>
            ${finalizeLabel(totals)}
          </button>
          <button class="quote-button" data-action="download-quote" ${currentOrder.items.length ? '' : 'disabled'}>Descargar cotizacion</button>
        </aside>
      </div>
    </section>
  `;
}

// Caja de totales compartida (panel POS y checkout). Los data-sum permiten
// refrescar los montos en sitio mientras se escribe, sin re-render (no se
// pierde el foco ni el punto decimal a mitad de tecleo).
function renderTotalsBox(totals) {
  return `
    <div class="totals-box">
      <div><span>Subtotal</span><strong data-sum="subtotal">${formatUsd(totals.subtotalUsd)} <small>${formatVes(chargedBs(totals.subtotalUsd))}</small></strong></div>
      <div><span>IVA</span><strong data-sum="iva">${formatUsd(totals.ivaUsd)}</strong></div>
      <div><span>IGTF</span><strong data-sum="igtf">${formatUsd(totals.igtfUsd)}</strong></div>
      <div><span>Margen estimado</span><strong data-sum="margin">${formatUsd(totals.estimatedMarginUsd)}</strong></div>
      <div class="grand-total"><span>Total</span><strong data-sum="total">${formatUsd(totals.totalUsd)} <small>${formatVes(chargedBs(totals.totalUsd))}</small></strong></div>
    </div>
  `;
}

// Refresca totales y montos de linea en el DOM sin re-render (edicion fluida).
function updateOrderTotalsInPlace() {
  const totals = calculateOrderTotals(currentOrder);
  document.querySelectorAll('[data-line-total]').forEach((el) => {
    const item = currentOrder.items.find((i) => i.id === el.dataset.lineTotal);
    if (item) el.textContent = formatUsd(item.quantity * item.priceUsd);
  });
  const sums = {
    subtotal: `${formatUsd(totals.subtotalUsd)} <small>${formatVes(chargedBs(totals.subtotalUsd))}</small>`,
    iva: formatUsd(totals.ivaUsd),
    igtf: formatUsd(totals.igtfUsd),
    margin: formatUsd(totals.estimatedMarginUsd),
    total: `${formatUsd(totals.totalUsd)} <small>${formatVes(chargedBs(totals.totalUsd))}</small>`
  };
  document.querySelectorAll('[data-sum]').forEach((el) => {
    if (sums[el.dataset.sum] !== undefined) el.innerHTML = sums[el.dataset.sum];
  });
  document.querySelectorAll('[data-action="finalize"]').forEach((btn) => {
    btn.innerHTML = finalizeLabel(totals);
  });
}

// Actualiza un campo del item en memoria SIN filtrar ceros (edicion en curso).
function patchOrderItem(itemId, patch) {
  currentOrder = {
    ...currentOrder,
    items: currentOrder.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i))
  };
}

function renderCheckoutRow(item) {
  return `
    <tr>
      <td><strong>${item.name}</strong></td>
      <td><small>${controlModeLabel(item.controlMode)}${item.supplierName ? ` · ${item.supplierName}` : ''}</small></td>
      <td><div class="qty-cell"><input class="cell-input" type="number" min="0" step="0.01" value="${item.quantity}" data-item-qty="${item.id}" /><span>${item.unit || ''}</span></div></td>
      <td><div class="qty-cell"><span>$</span><input class="cell-input" type="number" min="0" step="0.01" value="${item.estimatedCostUsd}" data-item-cost="${item.id}" title="Costo del producto (se guarda en el catalogo)" /></div></td>
      <td><div class="qty-cell"><span>$</span><input class="cell-input" type="number" min="0" step="0.01" value="${item.priceUsd}" data-item-price="${item.id}" /></div></td>
      <td class="num"><strong data-line-total="${item.id}">${formatUsd(item.quantity * item.priceUsd)}</strong></td>
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
      <input type="number" min="0" step="0.01" value="${item.quantity}" data-item-qty="${item.id}" />
      <b data-line-total="${item.id}">${formatUsd(item.quantity * item.priceUsd)}</b>
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

// ---- Pago mixto: reparto del total entre varios metodos ----
// Redondea a centavos para que la cobertura valide EXACTO lo que se abona.
function parseAmount(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? roundMoney(n) : 0;
}
// Metodos que se pueden usar en un pago mixto: los que representan UNA cuenta y
// moneda real (USD o VES). Excluye pseudo-metodos como "Pago Combinado" (MIXED).
function mixablePaymentMethods() {
  return state.paymentMethods.filter((m) => m.currency === 'USD' || m.currency === 'VES');
}
function mixedTotalUsd() {
  return roundMoney(mixablePaymentMethods().reduce((sum, m) => sum + parseAmount(mixedAmounts[m.id]), 0));
}
function mixedRemainingUsd(totalUsd) {
  return roundMoney(Number(totalUsd || 0) - mixedTotalUsd());
}
function mixedCovered(totalUsd) {
  return mixedTotalUsd() > 0 && Math.abs(mixedRemainingUsd(totalUsd)) < 0.01;
}
function canFinalizeOrder(totals) {
  if (!currentOrder.items.length) return false;
  if (paymentMode === 'credito') return Boolean(currentOrder.customerId);
  if (paymentMode === 'mixto') return mixedCovered(totals.totalUsd);
  return true;
}
function finalizeLabel(totals) {
  if (paymentMode === 'credito') return `Registrar credito ${formatUsd(totals.totalUsd)}`;
  if (paymentMode === 'mixto') return `Finalizar mixto ${formatUsd(totals.totalUsd)}`;
  return `Finalizar pedido ${formatUsd(totals.totalUsd)}`;
}
function renderPayModeTabs() {
  const modes = [
    ['contado', 'Pago de una'],
    ['mixto', 'Mixto'],
    ['credito', 'Credito']
  ];
  return `<div class="pay-mode">${modes
    .map(
      ([m, label]) =>
        `<button class="pay-mode-btn ${paymentMode === m ? 'active' : ''}" data-pay-mode="${m}">${label}</button>`
    )
    .join('')}</div>`;
}
function renderMixedPay(totals) {
  const remaining = mixedRemainingUsd(totals.totalUsd);
  const covered = mixedCovered(totals.totalUsd);
  const statusClass = covered ? 'ok' : remaining < 0 ? 'over' : '';
  const statusText = covered
    ? 'Pago completo ✓'
    : remaining < 0
      ? `Te pasaste por ${formatUsd(Math.abs(remaining))}`
      : `Falta ${formatUsd(remaining)}`;
  return `
    <div class="mixed-pay">
      ${mixablePaymentMethods()
        .map(
          (m) => `
        <div class="mixed-row">
          <div class="mixed-meta"><strong>${m.name}</strong><small>${m.accountName} · ${m.currency}</small></div>
          <div class="mixed-input">
            <span>$</span>
            <input type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"
              value="${mixedAmounts[m.id] ?? ''}" data-mixed-amount="${m.id}" />
            <button type="button" class="mixed-fill" data-mixed-fill="${m.id}" title="Asignar lo que falta">resto</button>
          </div>
        </div>`
        )
        .join('')}
      <div class="mixed-status ${statusClass}">
        <span>Asignado ${formatUsd(mixedTotalUsd())} / ${formatUsd(totals.totalUsd)}</span>
        <strong>${statusText}</strong>
      </div>
    </div>`;
}
function renderPaymentBody(totals) {
  if (paymentMode === 'credito') {
    return `
      <div class="credit-note">${
        currentOrder.customerId
          ? `Se registrara como cuenta por cobrar de <strong>${currentOrder.customerName}</strong>.`
          : 'Selecciona un cliente del sistema para dar credito.'
      }</div>
      <label class="credit-due">Fecha limite de pago
        <input type="date" value="${creditDueDate}" data-credit-due />
      </label>`;
  }
  if (paymentMode === 'mixto') return renderMixedPay(totals);
  return `<div class="payment-methods">${state.paymentMethods.map(renderPaymentMethod).join('')}</div>`;
}

// Texto legible del pago para recibos/detalle (desglosa el mixto).
function paymentSummaryText(payment) {
  if (!payment) return '';
  if (Array.isArray(payment.splits) && payment.splits.length) {
    return payment.splits.map((s) => `${s.methodName} ${formatUsd(s.amountUsd)}`).join(' · ');
  }
  return payment.methodName || '';
}

function renderSettings() {
  const s = state.settings;
  const lastSync = getSyncedAt();
  return `
    <section class="customers-panel settings-panel">
      <div class="section-heading">
        <h2>Configuracion</h2>
        <p>Los cambios se guardan automaticamente al salir de cada campo.</p>
      </div>

      <div class="settings-grid">
        <div class="settings-card">
          <h3>Datos del negocio</h3>
          <p class="muted-cell">Aparecen en facturas, recibos y cotizaciones.</p>
          <label>Nombre del negocio
            <input type="text" data-set-field="companyName" value="${s.companyName || ''}" />
          </label>
          <label>RIF
            <input type="text" data-set-field="businessRif" value="${s.businessRif || ''}" placeholder="J-12345678-9" />
          </label>
          <label>Telefono
            <input type="text" data-set-field="businessPhone" value="${s.businessPhone || ''}" placeholder="0424..." />
          </label>
          <label>Direccion
            <input type="text" data-set-field="businessAddress" value="${s.businessAddress || ''}" placeholder="Caracas · Venezuela" />
          </label>
        </div>

        <div class="settings-card">
          <h3>Preferencias de venta</h3>
          <label>Usuario (registrado como)
            <input type="text" data-set-field="userName" value="${s.userName || ''}" />
          </label>
          <label>Canal por defecto
            <select data-set-field="channel">
              <option value="Mayor" ${s.channel === 'Mayor' ? 'selected' : ''}>Mayor</option>
              <option value="Principal" ${s.channel === 'Principal' ? 'selected' : ''}>Detal (Principal)</option>
            </select>
          </label>
          <label>Dias de credito por defecto
            <input type="number" min="0" step="1" data-set-field="creditDays" value="${s.creditDays ?? 7}" />
          </label>
          <label>Margen de importacion por defecto (%)
            <input type="number" min="0" step="1" data-set-field="importMarginPct" value="${s.importMarginPct ?? 30}" />
          </label>
        </div>

        <div class="settings-card">
          <h3>Redondeo de bolivares</h3>
          <p class="muted-cell">Como se redondea el total en Bs al cobrar. Paso 0 = sin redondeo.</p>
          <label>Paso de redondeo (Bs)
            <input type="number" min="0" step="1" data-set-field="bsStep" value="${s.bsRounding?.step ?? 0}" />
          </label>
          <label>Modo
            <select data-set-field="bsMode">
              <option value="nearest" ${(s.bsRounding?.mode || 'nearest') === 'nearest' ? 'selected' : ''}>Al mas cercano</option>
              <option value="up" ${s.bsRounding?.mode === 'up' ? 'selected' : ''}>Siempre arriba</option>
              <option value="down" ${s.bsRounding?.mode === 'down' ? 'selected' : ''}>Siempre abajo</option>
            </select>
          </label>
        </div>

        <div class="settings-card">
          <h3>Base de datos (nube)</h3>
          <div class="settings-info">
            <div><span>Estado</span><strong>${
              { starting: 'Conectando...', ok: '✓ Sincronizada', local: 'Solo en este equipo', error: '⚠ Con error' }[cloudStatus.state] || cloudStatus.state
            }</strong></div>
            <div><span>Ultima sincronizacion</span><strong>${lastSync ? new Date(lastSync).toLocaleString('es-VE') : 'Nunca en este equipo'}</strong></div>
            <div><span>Productos</span><strong>${state.products.length}</strong></div>
            <div><span>Clientes</span><strong>${state.customers.length}</strong></div>
            <div><span>Ventas registradas</span><strong>${state.orders.length}</strong></div>
          </div>
          ${cloudStatus.detail ? `<p class="muted-cell" style="text-align:left">${cloudStatus.detail}</p>` : ''}
          <div class="backup-actions">
            <button class="ghost-button compact" data-action="export-backup">⬇ Descargar respaldo</button>
            <button class="ghost-button compact" data-action="import-backup">⬆ Restaurar respaldo</button>
            <input type="file" accept="application/json,.json" data-import-file style="display:none" />
          </div>
          <p class="muted-cell" style="text-align:left">Los datos se guardan en Supabase y se comparten entre todos los equipos donde inicies sesion. Descarga un respaldo cuando quieras: es un archivo con TODO el sistema, restaurable con un click.</p>
        </div>
      </div>
    </section>
  `;
}

function renderCatalog() {
  const q = search.trim().toLowerCase();
  const rows = [...state.products]
    .filter((p) => !q || `${p.name} ${p.sku} ${p.category || ''}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  return `
    <section class="catalog-panel">
      <div class="section-heading">
        <h2>Catalogo flexible</h2>
        <button class="primary-button compact" data-action="new-product">+ Nuevo producto</button>
      </div>
      <p class="muted-cell" style="text-align:left;margin:-8px 0 8px;">El modo define si afecta inventario, crea orden al galpon o se vende como servicio. Haz clic en Editar para cambiar precios, costo, stock o codigo.</p>
      <div class="search-row">
        <input type="search" placeholder="Buscar producto, codigo o categoria..." value="${search}" data-field="search" />
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Codigo</th><th>Producto</th><th>Modo</th><th>Detal</th><th>Mayor</th><th>Costo</th><th>Stock</th><th></th></tr></thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map(
                      (product) => `
                  <tr>
                    <td>${product.sku}</td>
                    <td><strong>${product.name}</strong>${product.supplierName ? `<br/><small class="muted-cell">${product.supplierName}</small>` : ''}</td>
                    <td><span class="mode-pill">${controlModeLabel(product.controlMode)}</span></td>
                    <td>${formatUsd(product.prices?.Principal ?? product.priceUsd)}</td>
                    <td>${formatUsd(product.prices?.Mayor ?? product.priceUsd)}</td>
                    <td>${formatUsd(product.estimatedCostUsd)}</td>
                    <td>${product.stock ?? 'No aplica'} ${product.stock === null ? '' : product.unit}</td>
                    <td><button class="ghost-button compact" data-edit-product="${product.id}">Editar</button></td>
                  </tr>
                `
                    )
                    .join('')
                : '<tr><td colspan="8" class="muted-cell">Sin productos que coincidan</td></tr>'
            }
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
      <div><strong>Emisor</strong>${state.settings.companyName}${state.settings.businessRif ? `<br/>RIF: ${state.settings.businessRif}` : ''}${state.settings.businessPhone ? `<br/>Telf: ${state.settings.businessPhone}` : ''}<br/>${state.settings.businessAddress || 'Caracas · Venezuela'}</div>
      <div style="text-align:right"><strong>Cliente</strong>${doc.customerName}</div>
    </div>
    <table>
      <thead><tr><th>Codigo</th><th>Producto</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Total</th></tr></thead>
      <tbody>${itemsHtml}</tbody>
    </table>
    <table class="totals"><tbody>${totalsRows}</tbody></table>
    ${
      showPayment
        ? `<div class="pay"><strong>Pago:</strong> ${
            Array.isArray(doc.payment.splits) && doc.payment.splits.length
              ? paymentSummaryText(doc.payment)
              : `${doc.payment.methodName} · ${formatUsd(doc.payment.amountUsd)}${doc.payment.amountVes ? ` / ${formatVes(doc.payment.amountVes)}` : ''}`
          }</div>`
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
    <div class="center brand">${state.settings.companyName || 'Veggies CCS'}</div>
    ${state.settings.businessRif ? `<div class="center muted">RIF: ${state.settings.businessRif}</div>` : ''}
    <div class="center muted">${state.settings.businessAddress || 'Caracas · Venezuela'}${state.settings.businessPhone ? ` · ${state.settings.businessPhone}` : ''}</div>
    <div class="line"></div>
    <div class="muted">Pedido #${order.orderNumber} · ${order.date}</div>
    <div class="muted">Cliente: ${(order.customerName || '').trim() || 'Mostrador'}</div>
    <div class="line"></div>
    ${itemsHtml}
    <div class="line"></div>
    <div class="total"><span>TOTAL</span><span>${formatUsd(t.totalUsd)}</span></div>
    <div class="trow"><span>Equivalente</span><b>${formatVes(t.totalVes || t.totalUsd * (order.exchangeRate?.value || 0))}</b></div>
    ${order.payment ? `<div class="trow"><span>Pago</span><b>${paymentSummaryText(order.payment)}</b></div>` : ''}
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
    // Reversa de caja: por cada parcial (mixto) o por el metodo unico.
    const reversalSources =
      Array.isArray(order.payment?.splits) && order.payment.splits.length
        ? order.payment.splits.map((s) => ({
            accountId: s.accountId,
            currency: s.currency,
            amount: s.currency === 'VES' ? s.amountVes : s.amountUsd
          }))
        : method && order.payment
          ? [
              {
                accountId: method.accountId,
                currency: method.currency === 'VES' ? 'VES' : 'USD',
                amount: method.currency === 'VES' ? order.payment.amountVes : order.payment.amountUsd
              }
            ]
          : [];
    const reversals = reversalSources
      .filter((r) => r.accountId)
      .map((r) =>
        createAdjustmentMovement({
          accountId: r.accountId,
          amount: -Number(r.amount || 0),
          currency: r.currency,
          note: reversalNote
        })
      );
    // Reversa de credito: si la venta genero cuenta por cobrar, se elimina y
    // se devuelven los abonos ya cobrados (montos historicos exactos, buscando
    // los movimientos originales de ese credito).
    const receivable = state.receivables.find((r) => r.orderId === order.id);
    if (receivable) {
      const abonoPrefix = `Abono credito #${order.orderNumber} ·`;
      const abonoReversals = state.accountMovements
        .filter((mv) => typeof mv.note === 'string' && mv.note.startsWith(abonoPrefix) && mv.amount > 0)
        .map((mv) =>
          createAdjustmentMovement({
            accountId: mv.accountId,
            amount: -mv.amount,
            currency: mv.currency,
            note: `${reversalNote} (devolucion de abono)`
          })
        );
      reversals.push(...abonoReversals);
      state.receivables = state.receivables.filter((r) => r.orderId !== order.id);
    }
    if (reversals.length) {
      state.accountMovements = [...reversals, ...state.accountMovements];
      state.accounts = applyMovements(state.accounts, reversals);
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

// ==================== MENSAJERIA (avisos por WhatsApp) ====================
let messagingSegment = 'cobranza';

const MESSAGING_SEGMENTS = [
  ['cobranza', '💵 Cobranza', 'Clientes con saldo pendiente o vencido'],
  ['pedido', '📦 Pedidos de hoy', 'Avisar que su pedido esta confirmado'],
  ['precios', '🥬 Precios del dia', 'Aviso de mercancia fresca a clientes activos'],
  ['dormidos', '😴 Dormidos', 'Clientes sin compras en los ultimos 30 dias']
];

function messageTemplates() {
  return { ...DEFAULT_TEMPLATES, ...(state.settings.messageTemplates || {}) };
}

function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || 'cliente';
}

// Construye la lista de destinatarios del segmento con sus variables.
function buildMessagingRows(segment) {
  const today = todayIso();
  const findCustomer = (id) => state.customers.find((c) => c.id === id);

  if (segment === 'cobranza') {
    const byCustomer = new Map();
    state.receivables
      .filter((r) => r.status !== 'paid')
      .forEach((r) => {
        const key = r.customerId || r.customerName;
        const g = byCustomer.get(key) || { receivables: [], customerId: r.customerId, name: r.customerName };
        g.receivables.push(r);
        byCustomer.set(key, g);
      });
    return Array.from(byCustomer.values())
      .map((g) => {
        const customer = g.customerId ? findCustomer(g.customerId) : null;
        const balance = roundMoney(g.receivables.reduce((s, r) => s + receivableBalance(r), 0));
        const due = g.receivables.map((r) => r.dueDate).filter(Boolean).sort()[0] || null;
        const overdueDays = due && due < today ? Math.round((new Date(today) - new Date(due)) / 86400000) : 0;
        const vencidoTxt = due
          ? overdueDays > 0
            ? ` que vencio el ${due} (hace ${overdueDays} dia${overdueDays === 1 ? '' : 's'})`
            : ` que vence el ${due}`
          : '';
        return {
          key: g.customerId || g.name,
          customerId: g.customerId,
          name: g.name,
          phone: customer?.phone || '',
          detail: `Debe ${formatUsd(balance)}${due ? ` · vence ${due}` : ''}${overdueDays > 0 ? ' · VENCIDA' : ''}`,
          overdue: overdueDays > 0,
          vars: { nombre: firstName(g.name), saldo: formatUsd(balance), vencidoTxt }
        };
      })
      .sort((a, b) => Number(b.overdue) - Number(a.overdue));
  }

  if (segment === 'pedido') {
    return state.orders
      .filter((o) => o.status === 'paid' && o.date === today)
      .map((o) => {
        const customer = o.customerId ? findCustomer(o.customerId) : null;
        return {
          key: `o-${o.id}`,
          customerId: o.customerId,
          name: (o.customerName || '').trim() || 'Mostrador',
          phone: customer?.phone || '',
          detail: `Pedido #${o.orderNumber} · ${formatUsd(o.totals?.totalUsd || 0)}`,
          vars: {
            nombre: firstName(o.customerName || 'cliente'),
            pedido: o.orderNumber,
            total: formatUsd(o.totals?.totalUsd || 0)
          }
        };
      });
  }

  if (segment === 'dormidos') {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const recentCustomerIds = new Set(
      state.orders.filter((o) => o.status === 'paid' && o.date >= cutoff).map((o) => o.customerId).filter(Boolean)
    );
    return state.customers
      .filter((c) => (c.status || '').toLowerCase() === 'activo' && !recentCustomerIds.has(c.id))
      .map((c) => ({
        key: c.id,
        customerId: c.id,
        name: c.name,
        phone: c.phone || '',
        detail: `${c.totalOrders || 0} compras historicas`,
        vars: { nombre: firstName(c.name) }
      }));
  }

  // precios: activos con telefono
  return state.customers
    .filter((c) => (c.status || '').toLowerCase() === 'activo')
    .map((c) => ({
      key: c.id,
      customerId: c.id,
      name: c.name,
      phone: c.phone || '',
      detail: c.topProduct ? `Suele pedir: ${c.topProduct}` : '',
      vars: { nombre: firstName(c.name) }
    }));
}

function lastMessageFor(key) {
  return (state.messageLog || []).find((m) => m.key === key) || null;
}

function renderMessaging() {
  const template = messageTemplates()[messagingSegment];
  const allRows = buildMessagingRows(messagingSegment);
  const rows = allRows.filter((r) => normalizePhoneVE(r.phone));
  const sinTelefono = allRows.length - rows.length;
  const today = todayIso();
  const sentToday = rows.filter((r) => {
    const last = lastMessageFor(r.key);
    return last && last.segment === messagingSegment && (last.sentAt || '').slice(0, 10) === today;
  }).length;
  const segMeta = MESSAGING_SEGMENTS.find(([k]) => k === messagingSegment);

  return `
    <section class="customers-panel">
      <div class="section-heading">
        <h2>Mensajeria</h2>
        <p>Avisos por WhatsApp con tu numero: el mensaje sale listo, tu solo das enviar.</p>
      </div>
      <div class="msg-segments">
        ${MESSAGING_SEGMENTS.map(
          ([k, label]) =>
            `<button class="msg-segment ${messagingSegment === k ? 'active' : ''}" data-msg-segment="${k}">${label}</button>`
        ).join('')}
      </div>
      <div class="msg-template-card">
        <div class="msg-template-head">
          <strong>Plantilla · ${segMeta?.[1] || ''}</strong>
          <button class="ghost-button compact" data-msg-reset>Restaurar original</button>
        </div>
        <textarea rows="3" data-msg-template>${template}</textarea>
        <small class="muted-cell" style="text-align:left">Variables: {nombre}${messagingSegment === 'cobranza' ? ', {saldo}, {vencidoTxt}' : ''}${messagingSegment === 'pedido' ? ', {pedido}, {total}' : ''} — ${segMeta?.[2] || ''}. Se guarda sola.</small>
      </div>
      <div class="msg-counter">
        <strong>${rows.length}</strong> cliente${rows.length === 1 ? '' : 's'} en la lista
        · <span class="${sentToday ? 'pos-cell' : ''}">${sentToday} avisado${sentToday === 1 ? '' : 's'} hoy</span>
        ${sinTelefono ? `· <span class="muted-cell">${sinTelefono} sin telefono valido (no salen en la lista)</span>` : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Cliente</th><th>Telefono</th><th>Detalle</th><th>Ultimo aviso</th><th></th></tr></thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map((r, i) => {
                      const last = lastMessageFor(r.key);
                      const doneToday = last && last.segment === messagingSegment && (last.sentAt || '').slice(0, 10) === today;
                      return `
                        <tr class="${r.overdue ? 'row-overdue' : ''}">
                          <td><strong>${r.name}</strong></td>
                          <td>${r.phone}</td>
                          <td>${r.detail || ''}</td>
                          <td>${last ? `<small class="muted-cell">${new Date(last.sentAt).toLocaleDateString('es-VE')} · ${MESSAGING_SEGMENTS.find(([k]) => k === last.segment)?.[1]?.slice(2) || last.segment}</small>` : '<small class="muted-cell">Nunca</small>'}</td>
                          <td class="msg-actions">
                            ${doneToday ? '<span class="status-pill delivered">✓ Hoy</span>' : ''}
                            <button class="primary-button compact" data-send-msg="${i}">Enviar</button>
                            <button class="ghost-button compact" data-copy-msg="${i}" title="Copiar el mensaje">Copiar</button>
                          </td>
                        </tr>`;
                    })
                    .join('')
                : `<tr><td colspan="5" class="muted-cell">No hay clientes en este segmento ahora mismo.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function sendSegmentMessage(index, { copyOnly = false } = {}) {
  const rows = buildMessagingRows(messagingSegment).filter((r) => normalizePhoneVE(r.phone));
  const row = rows[index];
  if (!row) return;
  const text = fillTemplate(messageTemplates()[messagingSegment], row.vars);
  if (copyOnly) {
    navigator.clipboard?.writeText(text);
  } else {
    const link = waLink(row.phone, text);
    if (!link) return;
    window.open(link, '_blank');
  }
  setState(() => {
    state.messageLog = [
      {
        id: crypto.randomUUID(),
        key: row.key,
        customerId: row.customerId || null,
        name: row.name,
        phone: row.phone,
        segment: messagingSegment,
        text,
        via: copyOnly ? 'copiado' : 'whatsapp',
        sentAt: new Date().toISOString()
      },
      ...(state.messageLog || [])
    ].slice(0, 500);
  });
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
        <button class="primary-button compact" data-action="new-customer">+ Nuevo cliente</button>
      </div>
      <p class="muted-cell" style="text-align:left;margin:-8px 0 8px;">Cartera de clientes con historial de compras. Haz clic en Editar para actualizar datos.</p>
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
            <th>Ordenes</th><th>Total gastado</th><th>Ticket prom.</th><th>Estatus</th><th></th>
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
                          <td><button class="ghost-button compact" data-edit-customer="${c.id}">Editar</button></td>
                        </tr>`
                    )
                    .join('')
                : '<tr><td colspan="9" class="muted-cell">Sin clientes que coincidan</td></tr>'
            }
          </tbody>
        </table>
      </div>
      <small class="muted-cell">Mostrando ${Math.min(rows.length, 200)} de ${all.length} clientes</small>
    </section>
  `;
}

function renderWebOrders() {
  return `
    <section class="customers-panel">
      <div class="section-heading">
        <h2>Pedidos web</h2>
        <button class="primary-button compact" data-action="refresh-weborders">Actualizar</button>
      </div>
      <p class="muted-cell" style="text-align:left;margin:-8px 0 8px;">Pedidos que tus clientes hacen desde veggiesccs.com/pedidos.</p>
      ${webOrdersStatus ? `<div class="rate-status">${webOrdersStatus}</div>` : ''}
      <div class="docs-order-list">
        ${
          webOrders.length
            ? webOrders.map(renderWebOrderCard).join('')
            : (webOrdersStatus ? '' : '<div class="empty-cart">No hay pedidos web nuevos. Dale a Actualizar.</div>')
        }
      </div>
    </section>
  `;
}

function renderWebOrderCard(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const when = (order.created_at || '').replace('T', ' ').slice(0, 16);
  return `
    <article class="docs-order">
      <div class="docs-order-head">
        <div>
          <span class="sku">${when} · ${order.customer_phone || 'sin tel'}</span>
          <h3>${order.customer_name || 'Cliente web'}</h3>
          ${order.address ? `<small class="muted-cell">${order.address}</small>` : ''}
        </div>
        <div class="docs-order-total">
          <strong>${formatUsd(order.total || 0)}</strong>
          <span class="status-pill prepared">${order.status || 'nuevo'}</span>
        </div>
      </div>
      <div class="web-items">
        ${items.map((it) => `<span class="method-pill">${it.qty} ${it.orderUnit || it.unit || ''} ${it.name}</span>`).join('')}
      </div>
      <div class="docs-actions">
        <button class="finish-button compact" data-load-weborder="${order.id}">Cargar al sistema</button>
        <button class="coral-button compact" data-dismiss-weborder="${order.id}">Descartar</button>
      </div>
    </article>
  `;
}

async function fetchWebOrders() {
  webOrdersStatus = 'Cargando pedidos...';
  render();
  const { data, error } = await supabase
    .from('web_orders')
    .select('*')
    .neq('status', 'descartado')
    .neq('status', 'cargado')
    .order('created_at', { ascending: false })
    .limit(80);
  if (error) {
    webOrdersStatus = `No se pudo cargar (${error.message}).`;
  } else {
    webOrders = data || [];
    webOrdersStatus = webOrders.length ? '' : 'No hay pedidos web nuevos por ahora.';
  }
  render();
}

async function dismissWebOrder(id) {
  await supabase.from('web_orders').update({ status: 'descartado' }).eq('id', id);
  webOrders = webOrders.filter((o) => o.id !== id);
  render();
}

async function loadWebOrderToSystem(id) {
  const order = webOrders.find((o) => o.id === id);
  if (!order) return;
  let draft = createOrderDraft({
    orderNumber: nextOrderNumber(),
    exchangeRate: state.settings.exchangeRate,
    channel: state.settings.channel,
    location: state.settings.location
  });
  // Vincula (o CREA) el cliente en la cartera a partir del pedido web:
  // busca por telefono normalizado; si no existe, lo crea con nombre,
  // telefono y direccion. Asi el pedido queda asociado y se le puede dar
  // credito, cobrar y avisar por Mensajeria.
  const webPhone = normalizePhoneVE(order.customer_phone);
  let customer = webPhone
    ? state.customers.find((c) => normalizePhoneVE(c.phone) === webPhone)
    : state.customers.find(
        (c) => c.name.trim().toLowerCase() === String(order.customer_name || '').trim().toLowerCase() && order.customer_name
      );
  if (!customer && (order.customer_name || '').trim()) {
    customer = {
      id: `c-${crypto.randomUUID().slice(0, 8)}`,
      number: String(state.customers.length + 1),
      status: 'Activo',
      name: order.customer_name.trim(),
      idDoc: '',
      phone: order.customer_phone || '',
      email: '',
      address: order.address || '',
      topProduct: '',
      totalOrders: 0,
      totalSpent: 0,
      avgTicket: 0
    };
    setState(() => {
      state.customers = [customer, ...state.customers];
    });
  }
  draft = {
    ...draft,
    customerId: customer?.id || null,
    customerName: customer?.name || order.customer_name || '',
    notes: `Pedido web · Tel: ${order.customer_phone || '—'} · Dir: ${order.address || '—'}`
  };
  (Array.isArray(order.items) ? order.items : []).forEach((it) => {
    const found = state.products.find((p) => p.id === it.id);
    const product = found || {
      id: it.id || `web-${crypto.randomUUID()}`,
      sku: '',
      name: it.name || 'Producto',
      unit: it.baseUnit || it.unit || 'Kg',
      priceUsd: Number(it.price || 0),
      estimatedCostUsd: 0,
      controlMode: 'on_demand',
      supplierName: ''
    };
    const priced = { ...product, priceUsd: Number(it.price ?? productPrice(product, draft.channel)) };
    draft = addItemToOrder(draft, priced, Number(it.baseQty ?? it.qty ?? 1));
  });
  currentOrder = draft;
  await supabase.from('web_orders').update({ status: 'cargado' }).eq('id', id);
  webOrders = webOrders.filter((o) => o.id !== id);
  activeView = 'checkout';
  render();
}

// ---- Helpers compartidos de cobrar/pagar ----
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function dueCellFor(item, overdueFn, today) {
  if (!item.dueDate) return '<span class="muted-cell">Sin fecha</span>';
  if (item.status === 'paid') return item.dueDate;
  const diff = Math.round((new Date(item.dueDate) - new Date(today)) / 86400000);
  if (diff < 0) return `<span class="due-badge overdue">${item.dueDate} · hace ${Math.abs(diff)}d</span>`;
  if (diff === 0) return `<span class="due-badge today">${item.dueDate} · hoy</span>`;
  return `<span class="due-badge">${item.dueDate} · en ${diff}d</span>`;
}
// Agrupa por deudor/acreedor y ordena: grupos con vencidas primero, luego por
// saldo; los totalmente saldados al final. Dentro: orden de cobranza.
function groupDebts(list, { nameOf, balanceOf, overdueFn, today }) {
  const map = new Map();
  list.forEach((item) => {
    const key = nameOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  const groups = Array.from(map.entries()).map(([name, items]) => {
    const sorted = [...items].sort((a, b) => {
      const rank = (r) => (r.status === 'paid' ? 2 : overdueFn(r, today) ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const da = a.dueDate || '9999-12-31';
      const db = b.dueDate || '9999-12-31';
      if (da !== db) return da < db ? -1 : 1;
      return (b.date || '').localeCompare(a.date || '');
    });
    return {
      name,
      items: sorted,
      balance: roundMoney(items.reduce((s, r) => s + balanceOf(r), 0)),
      openCount: items.filter((r) => r.status !== 'paid').length,
      hasOverdue: items.some((r) => overdueFn(r, today))
    };
  });
  return groups.sort((a, b) => {
    const rank = (g) => (g.balance <= 0 ? 2 : g.hasOverdue ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.balance - a.balance;
  });
}

// Acordeon de deudas: que grupos (cliente/proveedor) estan abiertos y que
// renglon muestra sus opciones de documento.
let expandedDebtGroups = new Set();
let expandedDebtRow = null;

// Cabecera plegable compartida por Cuentas por cobrar y por pagar.
function renderGroupBlock(g, { kind, label, tableHtml }) {
  const key = `${kind}:${g.name}`;
  const open = expandedDebtGroups.has(key);
  return `
    <div class="group-block ${g.hasOverdue ? 'has-overdue' : ''} ${open ? 'open' : ''}">
      <button type="button" class="group-head" data-debt-group="${key}" aria-expanded="${open}">
        <span class="group-caret">${open ? '▾' : '▸'}</span>
        <strong>${g.name}</strong>
        <span class="group-meta">
          ${g.hasOverdue ? '<span class="due-badge overdue">Vencido</span>' : ''}
          <span>${g.openCount ? `${g.openCount} pendiente${g.openCount === 1 ? '' : 's'}` : 'Al dia'}</span>
          <strong class="${g.balance > 0 ? 'neg-cell' : 'pos-cell'}">${label} ${formatUsd(g.balance)}</strong>
        </span>
      </button>
      ${open ? `<div class="table-wrap">${tableHtml}</div>` : ''}
    </div>
  `;
}

// Opciones de documento de un pedido (se despliegan al tocar el renglon).
function renderOrderDocActions(orderId, colspan) {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) {
    return `<tr class="debt-actions-row"><td colspan="${colspan}"><span class="muted-cell">Este credito no tiene un pedido vinculado.</span></td></tr>`;
  }
  return `
    <tr class="debt-actions-row">
      <td colspan="${colspan}">
        <div class="docs-actions">
          <span class="docs-actions-label">Pedido #${order.orderNumber}:</span>
          <button class="ghost-button compact" data-doc="factura|${order.id}">Factura</button>
          <button class="ghost-button compact" data-doc="nota_entrega|${order.id}">Nota entrega</button>
          <button class="ghost-button compact" data-doc="recibo|${order.id}">Recibo</button>
          <button class="ghost-button compact" data-doc="cotizacion|${order.id}">Cotizacion</button>
          <button class="ghost-button compact" data-thermal="${order.id}">Termico</button>
          <button class="wa-button compact" data-wa="${order.id}">WhatsApp</button>
        </div>
      </td>
    </tr>
  `;
}

function renderReceivables() {
  const today = todayIso();
  const summary = receivablesSummary(state.receivables, today);
  const statusLabels = { open: 'Pendiente', partial: 'Abonado', paid: 'Pagado' };
  const groups = groupDebts(state.receivables, {
    nameOf: (r) => r.customerName || 'Cliente',
    balanceOf: receivableBalance,
    overdueFn: isOverdue,
    today
  });

  const groupHtml = (g) =>
    renderGroupBlock(g, {
      kind: 'cobrar',
      label: 'Debe',
      tableHtml: `
        <table>
          <thead><tr><th>Pedido</th><th>Fecha</th><th>Vence</th><th>Total</th><th>Abonado</th><th>Saldo</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            ${g.items
              .map((r) => {
                const overdue = isOverdue(r, today);
                const open = expandedDebtRow === r.id;
                return `
                  <tr class="debt-row ${overdue ? 'row-overdue' : ''} ${open ? 'open' : ''}" data-debt-row="${r.id}" title="Toca para ver la factura y otros documentos">
                    <td><span class="row-caret">${open ? '▾' : '▸'}</span> #${r.orderNumber}</td>
                    <td>${r.date}</td>
                    <td>${dueCellFor(r, isOverdue, today)}</td>
                    <td>${formatUsd(r.totalUsd)}</td>
                    <td>${formatUsd(paidAmount(r))}</td>
                    <td><strong>${formatUsd(receivableBalance(r))}</strong></td>
                    <td><span class="status-pill ${overdue ? 'annulled' : r.status === 'paid' ? 'delivered' : r.status === 'partial' ? 'prepared' : 'pending'}">${overdue ? 'Vencida' : statusLabels[r.status] || r.status}</span></td>
                    <td>${r.status === 'paid' ? '' : `<button class="primary-button compact" data-abono="${r.id}">Abonar</button>`}</td>
                  </tr>
                  ${open ? renderOrderDocActions(r.orderId, 8) : ''}`;
              })
              .join('')}
          </tbody>
        </table>
      `
    });

  return `
    <section class="customers-panel">
      <div class="section-heading">
        <h2>Cuentas por cobrar</h2>
        <p>Agrupadas por cliente. Registra abonos hasta saldar cada deuda.</p>
      </div>
      <div class="dashboard-grid">
        ${metricCard('Por cobrar', formatUsd(summary.balanceUsd), `${summary.openCount} creditos abiertos`, 'solid')}
        ${metricCard('Vencido', formatUsd(summary.overdueUsd), `${summary.overdueCount} creditos vencidos`, summary.overdueCount ? 'alert' : '')}
        ${metricCard('Cobrado', formatUsd(summary.paidUsd), 'Abonos recibidos', '')}
        ${metricCard('Total a credito', formatUsd(summary.totalUsd), `${summary.totalCount} ventas`, '')}
      </div>
      ${
        groups.length
          ? groups.map(groupHtml).join('')
          : '<div class="empty-cart">Sin cuentas por cobrar. Las ventas a credito apareceran aqui.</div>'
      }
    </section>
    ${renderAccountModal()}
  `;
}

function renderPayables() {
  const today = todayIso();
  const summary = payablesSummary(state.payables, today);
  const statusLabels = { open: 'Pendiente', partial: 'Abonado', paid: 'Pagada' };
  const groups = groupDebts(state.payables, {
    nameOf: (p) => p.supplierName || 'Proveedor',
    balanceOf: payableBalance,
    overdueFn: isPayableOverdue,
    today
  });

  const groupHtml = (g) =>
    renderGroupBlock(g, {
      kind: 'pagar',
      label: 'Debes',
      tableHtml: `
        <table>
          <thead><tr><th>Concepto</th><th>Fecha</th><th>Vence</th><th>Total</th><th>Pagado</th><th>Saldo</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            ${g.items
              .map((p) => {
                const overdue = isPayableOverdue(p, today);
                return `
                  <tr class="${overdue ? 'row-overdue' : ''}">
                    <td>${p.concept || 'Compra'}${p.note ? `<br/><small class="muted-cell">${p.note}</small>` : ''}</td>
                    <td>${p.date}</td>
                    <td>${dueCellFor(p, isPayableOverdue, today)}</td>
                    <td>${formatUsd(p.totalUsd)}</td>
                    <td>${formatUsd(payablePaidAmount(p))}</td>
                    <td><strong>${formatUsd(payableBalance(p))}</strong></td>
                    <td><span class="status-pill ${overdue ? 'annulled' : p.status === 'paid' ? 'delivered' : p.status === 'partial' ? 'prepared' : 'pending'}">${overdue ? 'Vencida' : statusLabels[p.status] || p.status}</span></td>
                    <td>${p.status === 'paid' ? '' : `<button class="primary-button compact" data-pagar="${p.id}">Pagar</button>`}</td>
                  </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      `
    });

  return `
    <section class="customers-panel">
      <div class="section-heading">
        <h2>Cuentas por pagar</h2>
        <button class="primary-button compact" data-action="new-payable">+ Nueva cuenta por pagar</button>
      </div>
      <p class="muted-cell" style="text-align:left;margin:-8px 0 8px;">Lo que le debes a tus proveedores, agrupado. Tambien puedes generarlas desde una orden del Galpon.</p>
      <div class="dashboard-grid">
        ${metricCard('Por pagar', formatUsd(summary.balanceUsd), `${summary.openCount} deudas abiertas`, 'solid')}
        ${metricCard('Vencido', formatUsd(summary.overdueUsd), `${summary.overdueCount} deudas vencidas`, summary.overdueCount ? 'alert' : '')}
        ${metricCard('Pagado', formatUsd(summary.paidUsd), 'Pagos realizados', '')}
        ${metricCard('Total registrado', formatUsd(summary.totalUsd), `${summary.totalCount} cuentas`, '')}
      </div>
      ${
        groups.length
          ? groups.map(groupHtml).join('')
          : '<div class="empty-cart">Sin cuentas por pagar. Crea una con el boton o desde una orden del Galpon.</div>'
      }
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

// Aplica una tasa como TASA DE COBRO en todo el sistema: settings (la usan
// abonos, pagos, transferencias y equivalentes) + el pedido en curso + auditoria.
function applyChargedRate(value, source, reason) {
  const prev = state.settings.exchangeRate.value;
  const today = new Date().toISOString().slice(0, 10);
  setState(() => {
    if (rateChanged(prev, value)) {
      state.rateAudit = [
        createRateAuditEntry({ fromValue: prev, toValue: roundMoney(value), source, reason }),
        ...state.rateAudit
      ];
    }
    state.rateHistory = recordRate(state.rateHistory, { value: roundMoney(value), source, date: today });
    state.settings.exchangeRate = { value: roundMoney(value), source, date: today };
    currentOrder = { ...currentOrder, exchangeRate: state.settings.exchangeRate };
  });
}

async function getBcvRate() {
  const res = await fetch('https://ve.dolarapi.com/v1/dolares/oficial', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const value = Number(data.promedio);
  if (!value) throw new Error('Respuesta sin tasa');
  return roundMoney(value);
}

async function fetchBcvRate() {
  bcvStatus = 'Consultando tasa BCV...';
  render();
  try {
    const value = await getBcvRate();
    // El boton aplica la tasa BCV como tasa de cobro en TODO el sistema.
    applyChargedRate(value, 'BCV', 'Actualizacion BCV desde el modulo de tasa');
    bcvStatus = `BCV ${value} Bs/$ aplicado como tasa de cobro en todo el sistema.`;
    render();
  } catch (error) {
    bcvStatus = `No se pudo consultar el BCV (${error.message}). Ingresa la tasa manualmente.`;
    render();
  }
}

// Al abrir la app: refresca el BCV solo. Respeta una tasa manual fijada HOY
// (override del dia); si la tasa vigente es de otro dia o vino del BCV, se
// actualiza automaticamente para no cobrar con una tasa vieja.
async function autoRefreshBcv() {
  try {
    const value = await getBcvRate();
    const charged = state.settings.exchangeRate;
    const today = new Date().toISOString().slice(0, 10);
    const manualToday = charged.source === 'manual' && charged.date === today;
    if (!manualToday && rateChanged(charged.value, value)) {
      applyChargedRate(value, 'BCV', 'Actualizacion automatica BCV al abrir');
    } else {
      // Solo registra la referencia BCV del dia en el historial.
      setState(() => {
        state.rateHistory = recordRate(state.rateHistory, { value, source: 'BCV', date: today });
      });
    }
  } catch {
    /* sin internet: se sigue con la tasa guardada */
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

  applyChargedRate(value, 'manual', reason);
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
        ${
          order.payableId
            ? '<span class="done-label">Cuenta por pagar creada ✓</span>'
            : order.status === 'cancelled'
              ? ''
              : `<button class="ghost-button compact" data-make-payable="${order.id}">Registrar cuenta por pagar</button>`
        }
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
  if (selectedAccountId) return renderAccountDetail(selectedAccountId);
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
          <button class="receivable-chip" data-view="receivables" title="Ver cuentas por cobrar">Por cobrar ${formatUsd(receivablesSummary(state.receivables).balanceUsd)} →</button>
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
    <article class="account-card clickable" data-account-detail="${account.id}">
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
      <span class="acct-see">Ver historial →</span>
    </article>
  `;
}

function accountMovementLabel(type) {
  return {
    payment: 'Pago de venta',
    income: 'Ingreso',
    withdrawal: 'Retiro',
    transfer_in: 'Transferencia (entra)',
    transfer_out: 'Transferencia (sale)'
  }[type] || type;
}

function renderAccountDetail(accountId) {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) {
    selectedAccountId = null;
    return renderAccounts();
  }
  const fmt = (v) => (account.currency === 'VES' ? formatVes(v) : formatUsd(v));
  const rate = state.settings.exchangeRate.value;

  // Movimientos de esta cuenta, en orden cronologico, con saldo corriente.
  const moves = state.accountMovements
    .filter((m) => m.accountId === accountId)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const net = moves.reduce((s, m) => s + Number(m.amount || 0), 0);
  const startBalance = roundMoney(Number(account.balance || 0) - net);
  let running = startBalance;
  const rows = moves.map((m) => {
    running = roundMoney(running + Number(m.amount || 0));
    return { ...m, balanceAfter: running };
  });
  rows.reverse(); // mostrar lo mas reciente arriba

  const ingresos = roundMoney(moves.filter((m) => m.amount > 0).reduce((s, m) => s + m.amount, 0));
  const egresos = roundMoney(moves.filter((m) => m.amount < 0).reduce((s, m) => s + Math.abs(m.amount), 0));

  return `
    <section class="accounts-panel">
      <div class="account-detail-head">
        <button class="ghost-button compact" data-action="close-account-detail">&larr; Cuentas</button>
        <div>
          <span class="sku">${account.currency}${account.currency === 'VES' && rate ? ` · equivale a ${formatUsd(account.balance / rate)}` : ''}</span>
          <h2>${account.name}</h2>
        </div>
        <div class="account-detail-balance">
          <small>Saldo actual</small>
          <strong>${fmt(account.balance)}</strong>
        </div>
      </div>

      <div class="dashboard-grid">
        ${metricCard('Saldo actual', fmt(account.balance), account.currency, 'solid')}
        ${metricCard('Total ingresos', fmt(ingresos), `${moves.filter((m) => m.amount > 0).length} movimientos`, '')}
        ${metricCard('Total egresos', fmt(egresos), `${moves.filter((m) => m.amount < 0).length} movimientos`, '')}
        ${metricCard('Saldo inicial', fmt(startBalance), 'Antes de movimientos', '')}
      </div>

      <div class="table-wrap">
        <table>
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th>Tasa</th><th>Monto</th><th>Saldo</th></tr></thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map(
                      (m) => `
                        <tr>
                          <td>${(m.createdAt || '').slice(0, 10)}<br/><small class="muted-cell">${(m.createdAt || '').slice(11, 16)}</small></td>
                          <td>${accountMovementLabel(m.type)}</td>
                          <td>${m.note || ''}</td>
                          <td>${m.rate ? `${m.rate} Bs/$` : '—'}</td>
                          <td class="${m.amount < 0 ? 'neg-cell' : 'pos-cell'}">${m.amount < 0 ? '' : '+'}${fmt(m.amount)}</td>
                          <td><strong>${fmt(m.balanceAfter)}</strong></td>
                        </tr>`
                    )
                    .join('')
                : '<tr><td colspan="6" class="muted-cell">Esta cuenta aun no tiene movimientos.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </section>
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
  } else if (m.type === 'abono' || m.type === 'pago-payable') {
    // Multipago: el monto se reparte entre una o varias cuentas.
    const isAbono = m.type === 'abono';
    const target = isAbono
      ? state.receivables.find((r) => r.id === m.receivableId)
      : state.payables.find((p) => p.id === m.payableId);
    const balance = target ? (isAbono ? receivableBalance(target) : payableBalance(target)) : 0;
    const rate = state.settings.exchangeRate.value;
    title = isAbono ? `Abonar a ${target?.customerName || ''}` : `Pagar a ${target?.supplierName || ''}`;
    body = `
      <div class="modal-preview">${isAbono ? 'Saldo pendiente' : 'Debes'}: <strong>${formatUsd(balance)}</strong>${!isAbono && target?.concept ? ` · ${target.concept}` : ''}</div>
      <p class="split-hint">Reparte el monto entre las cuentas donde ${isAbono ? 'entra' : 'sale'} el dinero (una o varias). Tasa: ${rate} Bs/$.</p>
      <div class="modal-splits">
        ${state.accounts
          .map(
            (a) => `
          <div class="mixed-row">
            <div class="mixed-meta"><strong>${a.name}</strong><small ${a.currency === 'VES' ? `data-split-ves="${a.id}"` : ''}>${a.currency === 'VES' ? `VES · ${formatVes(applyBsRounding((Number((m.splits || {})[a.id]) || 0) * rate, state.settings.bsRounding))}` : 'USD'}</small></div>
            <div class="mixed-input">
              <span>$</span>
              <input type="number" min="0" step="0.01" placeholder="0.00" value="${(m.splits || {})[a.id] ?? ''}" data-modal-split="${a.id}" />
              <button type="button" class="mixed-fill" data-modal-fill="${a.id}" title="Asignar lo que falta">resto</button>
            </div>
          </div>`
          )
          .join('')}
      </div>
      <div class="mixed-status" data-split-status></div>
      <label>Nota
        <input type="text" data-modal-field="note" value="${m.note || ''}" placeholder="${isAbono ? 'Abono / referencia...' : 'Pago / referencia...'}" />
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

// ==== Modal generico de formulario (clientes, productos, cuentas por pagar) ====
// Los inputs actualizan editModal.values en memoria sin re-render (tecleo fluido);
// el render ocurre al guardar o cerrar.
let editModal = null; // { kind, id: null|string, values: {...} }

function fieldRow(label, key, value, opts = {}) {
  if (opts.options) {
    return `<label>${label}
      <select data-edit-field="${key}">
        ${opts.options.map(([v, l]) => `<option value="${v}" ${String(value) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </label>`;
  }
  return `<label>${label}
    <input type="${opts.type || 'text'}" ${opts.step ? `step="${opts.step}"` : ''} ${opts.list ? `list="${opts.list}" autocomplete="off"` : ''} data-edit-field="${key}" value="${value ?? ''}" placeholder="${opts.placeholder || ''}" />
  </label>`;
}

function renderEditModal() {
  if (!editModal) return '';
  const v = editModal.values;
  let title = '';
  let body = '';
  if (editModal.kind === 'customer') {
    title = editModal.id ? `Editar cliente` : 'Nuevo cliente';
    body = `
      ${fieldRow('Nombre', 'name', v.name, { placeholder: 'Nombre del cliente o negocio' })}
      ${fieldRow('Cedula / RIF', 'idDoc', v.idDoc, { placeholder: 'V-12.345.678 / J-...' })}
      ${fieldRow('Telefono', 'phone', v.phone, { placeholder: '0412...' })}
      ${fieldRow('Direccion', 'address', v.address, { placeholder: 'Zona / direccion de entrega' })}
      ${fieldRow('Estatus', 'status', v.status, { options: [['Activo', 'Activo'], ['Inactivo', 'Inactivo']] })}
    `;
  } else if (editModal.kind === 'product') {
    title = editModal.id ? `Editar producto` : 'Nuevo producto';
    body = `
      ${fieldRow('Nombre', 'name', v.name, { placeholder: 'Nombre del producto' })}
      <div class="modal-grid-2">
        ${fieldRow('Codigo (SKU)', 'sku', v.sku, { placeholder: 'VC000' })}
        ${fieldRow('Unidad', 'unit', v.unit, { options: [['Kg', 'Kg'], ['Und', 'Und'], ['Caja', 'Caja'], ['Bulto', 'Bulto'], ['Servicio', 'Servicio']] })}
      </div>
      ${fieldRow('Modo de control', 'controlMode', v.controlMode, {
        options: [
          ['on_demand', 'Bajo pedido (galpon)'],
          ['inventory', 'Inventario (descuenta stock)'],
          ['no_inventory', 'Sin inventario'],
          ['service', 'Servicio']
        ]
      })}
      <div class="modal-grid-2">
        ${fieldRow('Costo (USD)', 'estimatedCostUsd', v.estimatedCostUsd, { type: 'number', step: '0.01' })}
        ${fieldRow('Stock', 'stock', v.stock, { type: 'number', step: '0.01' })}
      </div>
      <div class="modal-grid-2">
        ${fieldRow('Precio detal (USD)', 'pricePrincipal', v.pricePrincipal, { type: 'number', step: '0.01' })}
        ${fieldRow('Precio mayor (USD)', 'priceMayor', v.priceMayor, { type: 'number', step: '0.01' })}
      </div>
      ${fieldRow('Proveedor', 'supplierName', v.supplierName, { placeholder: 'Galpon Principal' })}
    `;
  } else if (editModal.kind === 'payable') {
    title = editModal.id ? 'Editar cuenta por pagar' : 'Nueva cuenta por pagar';
    body = `
      ${fieldRow('Proveedor', 'supplierName', v.supplierName, { placeholder: 'Escribe y elige de la lista...', list: 'suppliers-datalist' })}
      <datalist id="suppliers-datalist">
        ${(state.suppliers || []).map((s) => `<option value="${s.name}"></option>`).join('')}
      </datalist>
      <small class="muted-cell" style="text-align:left;margin-top:-6px;">Si escribes un nombre parecido a uno guardado, se unifica con ese proveedor; si es nuevo, se guarda solo.</small>
      ${fieldRow('Concepto', 'concept', v.concept, { placeholder: 'Factura / compra / flete...' })}
      <div class="modal-grid-2">
        ${fieldRow('Monto (USD)', 'totalUsd', v.totalUsd, { type: 'number', step: '0.01' })}
        ${fieldRow('Fecha limite', 'dueDate', v.dueDate, { type: 'date' })}
      </div>
      ${fieldRow('Nota', 'note', v.note, { placeholder: 'Opcional' })}
    `;
  }
  return `
    <div class="modal-overlay" data-action="close-edit-modal">
      <div class="modal" data-modal-stop>
        <div class="modal-head"><h3>${title}</h3><button class="modal-close" data-action="close-edit-modal">x</button></div>
        <form class="modal-form" data-action="submit-edit-modal">
          ${body}
          <div class="modal-actions">
            <button type="button" class="ghost-button compact" data-action="close-edit-modal">Cancelar</button>
            <button type="submit" class="primary-button compact">Guardar</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function submitEditModal() {
  if (!editModal) return;
  const v = editModal.values;
  const num = (x) => roundMoney(Math.max(0, Number(x || 0)));
  if (editModal.kind === 'customer') {
    if (!String(v.name || '').trim()) return window.alert('El nombre es obligatorio.');
    if (editModal.id) {
      setState(() => {
        state.customers = state.customers.map((c) =>
          c.id === editModal.id
            ? { ...c, name: v.name.trim(), idDoc: v.idDoc || '', phone: v.phone || '', address: v.address || '', status: v.status || 'Activo' }
            : c
        );
      });
    } else {
      setState(() => {
        state.customers = [
          {
            id: `c-${crypto.randomUUID().slice(0, 8)}`,
            number: String(state.customers.length + 1),
            status: v.status || 'Activo',
            name: v.name.trim(),
            idDoc: v.idDoc || '',
            phone: v.phone || '',
            email: '',
            address: v.address || '',
            topProduct: '',
            totalOrders: 0,
            totalSpent: 0,
            avgTicket: 0
          },
          ...state.customers
        ];
      });
    }
  } else if (editModal.kind === 'product') {
    if (!String(v.name || '').trim()) return window.alert('El nombre es obligatorio.');
    const prices = { Principal: num(v.pricePrincipal), Mayor: num(v.priceMayor) || num(v.pricePrincipal) };
    if (editModal.id) {
      setState(() => {
        state.products = state.products.map((p) => {
          if (p.id !== editModal.id) return p;
          const newStock = v.stock === '' || v.stock === null ? p.stock : num(v.stock);
          // Si es inventariable y cambio el stock, deja rastro en el kardex.
          if (p.controlMode === 'inventory' && Number(newStock) !== Number(p.stock || 0)) {
            const adjustment = createInventoryAdjustment({
              product: p,
              quantity: roundMoney(Number(newStock) - Number(p.stock || 0)),
              note: 'Ajuste manual desde catalogo'
            });
            state.inventoryMovements = [adjustment, ...state.inventoryMovements];
          }
          return {
            ...p,
            name: v.name.trim(),
            sku: (v.sku || '').trim() || p.sku,
            unit: v.unit || p.unit,
            controlMode: v.controlMode || p.controlMode,
            estimatedCostUsd: num(v.estimatedCostUsd),
            stock: newStock,
            prices,
            priceUsd: prices.Principal,
            supplierName: (v.supplierName || '').trim()
          };
        });
      });
    } else {
      setState(() => {
        state.products = [
          ...state.products,
          {
            id: `p-${crypto.randomUUID().slice(0, 8)}`,
            sku: (v.sku || '').trim() || `VC${String(state.products.length + 1).padStart(3, '0')}`,
            name: v.name.trim(),
            unit: v.unit || 'Kg',
            category: 'General',
            priceUsd: prices.Principal,
            prices,
            estimatedCostUsd: num(v.estimatedCostUsd),
            controlMode: v.controlMode || 'on_demand',
            stock: v.stock === '' || v.stock === null ? 0 : num(v.stock),
            supplierId: 'sup-galpon',
            supplierName: (v.supplierName || '').trim() || 'Galpon Principal'
          }
        ];
      });
    }
  } else if (editModal.kind === 'payable') {
    if (!String(v.supplierName || '').trim()) return window.alert('El proveedor es obligatorio.');
    if (!num(v.totalUsd)) return window.alert('El monto debe ser mayor a 0.');
    if (editModal.id) {
      setState(() => {
        // Unifica el nombre con el registro de proveedores (o crea uno nuevo).
        const supplier = resolveSupplier(v.supplierName);
        state.payables = state.payables.map((p) =>
          p.id === editModal.id
            ? { ...p, supplierName: supplier.name, supplierId: supplier.id, concept: v.concept || '', totalUsd: num(v.totalUsd), dueDate: v.dueDate || null, note: v.note || '' }
            : p
        );
      });
    } else {
      setState(() => {
        const supplier = resolveSupplier(v.supplierName);
        state.payables = [
          {
            ...createPayable({
              supplierName: supplier.name,
              concept: v.concept || '',
              totalUsd: num(v.totalUsd),
              dueDate: v.dueDate || null,
              note: v.note || ''
            }),
            supplierId: supplier.id
          },
          ...state.payables
        ];
      });
    }
  }
  editModal = null;
}

function bindEditModal() {
  if (!editModal) return;
  document.querySelectorAll('[data-edit-field]').forEach((input) => {
    input.addEventListener('input', () => {
      editModal.values[input.dataset.editField] = input.value;
    });
    input.addEventListener('change', () => {
      editModal.values[input.dataset.editField] = input.value;
    });
  });
  document.querySelectorAll('[data-action="close-edit-modal"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target !== el) return;
      editModal = null;
      render();
    });
  });
  document.querySelector('[data-action="submit-edit-modal"]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    submitEditModal();
    render();
  });
  document.querySelector('.modal [data-modal-stop]')?.addEventListener('click', (e) => e.stopPropagation());
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
  } else if (m.type === 'abono' || m.type === 'pago-payable') {
    // Multipago: un movimiento por cada cuenta con monto > 0.
    const isAbono = m.type === 'abono';
    const target = isAbono
      ? state.receivables.find((r) => r.id === m.receivableId)
      : state.payables.find((p) => p.id === m.payableId);
    if (!target) return;
    const balance = isAbono ? receivableBalance(target) : payableBalance(target);
    const splits = state.accounts
      .map((account) => ({
        account,
        amountUsd: roundMoney(Math.max(0, Number((m.splits || {})[account.id] || 0)))
      }))
      .filter((s) => s.amountUsd > 0);
    const totalUsd = roundMoney(splits.reduce((sum, s) => sum + s.amountUsd, 0));
    if (!totalUsd) {
      window.alert('Escribe el monto en al menos una cuenta.');
      return;
    }
    if (totalUsd > balance + 0.01) {
      window.alert(`El total (${formatUsd(totalUsd)}) supera el saldo pendiente (${formatUsd(balance)}).`);
      return;
    }
    const rate = state.settings.exchangeRate.value;
    setState(() => {
      let updated = target;
      const movements = [];
      splits.forEach((s) => {
        if (isAbono) {
          ({ receivable: updated } = addAbono(updated, { amountUsd: s.amountUsd, methodName: s.account.name, note: m.note, accountId: s.account.id }));
        } else {
          ({ payable: updated } = addPago(updated, { amountUsd: s.amountUsd, methodName: s.account.name, note: m.note, accountId: s.account.id }));
        }
        const movementAmount =
          s.account.currency === 'VES'
            ? applyBsRounding(s.amountUsd * rate, state.settings.bsRounding)
            : s.amountUsd;
        movements.push(
          createAdjustmentMovement({
            accountId: s.account.id,
            amount: isAbono ? movementAmount : -movementAmount,
            currency: s.account.currency === 'VES' ? 'VES' : 'USD',
            note: isAbono
              ? `Abono credito #${target.orderNumber} · ${target.customerName}${splits.length > 1 ? ' (multipago)' : ''}`
              : `Pago a proveedor · ${target.supplierName}${target.concept ? ` · ${target.concept}` : ''}${splits.length > 1 ? ' (multipago)' : ''}`
          })
        );
      });
      if (isAbono) {
        state.receivables = state.receivables.map((r) => (r.id === target.id ? updated : r));
      } else {
        state.payables = state.payables.map((p) => (p.id === target.id ? updated : p));
      }
      state.accountMovements = [...movements, ...state.accountMovements];
      state.accounts = applyMovements(state.accounts, movements);
    });
  }
  accountModal = null;
  render();
}

function bindAccountModal() {
  document.querySelectorAll('[data-acct-action]').forEach((button) => {
    button.addEventListener('click', () => openAccountModal(button.dataset.acctAction));
  });
  document.querySelectorAll('[data-account-detail]').forEach((card) => {
    card.addEventListener('click', () => {
      selectedAccountId = card.dataset.accountDetail;
      render();
    });
  });
  document.querySelector('[data-action="close-account-detail"]')?.addEventListener('click', () => {
    selectedAccountId = null;
    render();
  });
  // Acordeon de cobrar/pagar: abrir-cerrar cliente/proveedor y ver documentos.
  document.querySelectorAll('[data-debt-group]').forEach((head) => {
    head.addEventListener('click', () => {
      const key = head.dataset.debtGroup;
      if (expandedDebtGroups.has(key)) expandedDebtGroups.delete(key);
      else expandedDebtGroups.add(key);
      render();
    });
  });
  document.querySelectorAll('[data-debt-row]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('button')) return; // los botones internos hacen lo suyo
      const id = row.dataset.debtRow;
      expandedDebtRow = expandedDebtRow === id ? null : id;
      render();
    });
  });

  document.querySelectorAll('[data-abono]').forEach((button) => {
    button.addEventListener('click', () => {
      accountModal = { type: 'abono', receivableId: button.dataset.abono, splits: {}, note: '' };
      render();
    });
  });
  document.querySelectorAll('[data-pagar]').forEach((button) => {
    button.addEventListener('click', () => {
      accountModal = { type: 'pago-payable', payableId: button.dataset.pagar, splits: {}, note: '' };
      render();
    });
  });

  // Reparto multipago dentro del modal (abono/pago): estado en vivo sin re-render.
  const splitBalance = () => {
    const m = accountModal;
    if (!m) return 0;
    if (m.type === 'abono') {
      const r = state.receivables.find((x) => x.id === m.receivableId);
      return r ? receivableBalance(r) : 0;
    }
    const p = state.payables.find((x) => x.id === m.payableId);
    return p ? payableBalance(p) : 0;
  };
  const splitTotal = () => {
    const m = accountModal;
    if (!m) return 0;
    return roundMoney(
      state.accounts.reduce((sum, a) => sum + Math.max(0, Number((m.splits || {})[a.id] || 0)), 0)
    );
  };
  const updateSplitStatus = () => {
    const el = document.querySelector('[data-split-status]');
    if (!el) return;
    // Equivalente en Bs por fila (cuentas VES) a la tasa vigente.
    document.querySelectorAll('[data-split-ves]').forEach((small) => {
      const usd = Math.max(0, Number((accountModal?.splits || {})[small.dataset.splitVes] || 0));
      small.textContent = `VES · ${formatVes(applyBsRounding(usd * state.settings.exchangeRate.value, state.settings.bsRounding))}`;
    });
    const balance = splitBalance();
    const total = splitTotal();
    const remaining = roundMoney(balance - total);
    el.classList.remove('ok', 'over');
    if (total > 0 && Math.abs(remaining) < 0.01) el.classList.add('ok');
    if (remaining < -0.01) el.classList.add('over');
    el.innerHTML = `<span>Asignado ${formatUsd(total)} / ${formatUsd(balance)}</span><strong>${
      remaining < -0.01
        ? `Te pasaste por ${formatUsd(Math.abs(remaining))}`
        : Math.abs(remaining) < 0.01 && total > 0
          ? 'Cubre todo el saldo ✓'
          : `Queda ${formatUsd(remaining)} pendiente`
    }</strong>`;
  };
  updateSplitStatus();
  document.querySelectorAll('[data-modal-split]').forEach((input) => {
    input.addEventListener('input', () => {
      if (!accountModal) return;
      accountModal.splits = { ...(accountModal.splits || {}), [input.dataset.modalSplit]: input.value };
      updateSplitStatus();
    });
  });
  document.querySelectorAll('[data-modal-fill]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!accountModal) return;
      const id = button.dataset.modalFill;
      const others = state.accounts.reduce(
        (sum, a) => (a.id === id ? sum : sum + Math.max(0, Number((accountModal.splits || {})[a.id] || 0))),
        0
      );
      const fill = roundMoney(Math.max(0, splitBalance() - others));
      accountModal.splits = { ...(accountModal.splits || {}), [id]: fill ? String(fill) : '' };
      const input = document.querySelector(`[data-modal-split="${id}"]`);
      if (input) input.value = fill ? String(fill) : '';
      updateSplitStatus();
    });
  });
  document.querySelectorAll('[data-make-payable]').forEach((button) => {
    button.addEventListener('click', () => {
      const so = state.supplierOrders.find((o) => o.id === button.dataset.makePayable);
      if (!so || so.payableId) return;
      const margin = calculateSupplierOrderMargin(so);
      const total = roundMoney(margin.actualCostUsd || margin.estimatedCostUsd || 0);
      if (!total) {
        window.alert('La orden no tiene costo todavia. Carga el costo real primero.');
        return;
      }
      setState(() => {
        const supplier = resolveSupplier(so.supplierName);
        const payable = {
          ...createPayable({
            supplierName: supplier.name,
            concept: `Orden galpon · pedido #${so.saleOrderNumber}`,
            totalUsd: total,
            dueDate: defaultCreditDue(),
            sourceOrderId: so.id
          }),
          supplierId: supplier.id
        };
        state.payables = [payable, ...state.payables];
        state.supplierOrders = state.supplierOrders.map((o) =>
          o.id === so.id ? { ...o, payableId: payable.id } : o
        );
      });
      activeView = 'payables';
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
  bindEditModal();

  // CRUD: clientes, productos y cuentas por pagar
  document.querySelector('[data-action="new-customer"]')?.addEventListener('click', () => {
    editModal = { kind: 'customer', id: null, values: { name: '', idDoc: '', phone: '', address: '', status: 'Activo' } };
    render();
  });
  document.querySelectorAll('[data-edit-customer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = state.customers.find((x) => x.id === btn.dataset.editCustomer);
      if (!c) return;
      editModal = { kind: 'customer', id: c.id, values: { name: c.name, idDoc: c.idDoc || '', phone: c.phone || '', address: c.address || '', status: c.status || 'Activo' } };
      render();
    });
  });
  document.querySelector('[data-action="new-product"]')?.addEventListener('click', () => {
    editModal = {
      kind: 'product',
      id: null,
      values: { name: '', sku: '', unit: 'Kg', controlMode: 'on_demand', estimatedCostUsd: '', stock: '', pricePrincipal: '', priceMayor: '', supplierName: 'Galpon Principal' }
    };
    render();
  });
  document.querySelectorAll('[data-edit-product]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = state.products.find((x) => x.id === btn.dataset.editProduct);
      if (!p) return;
      editModal = {
        kind: 'product',
        id: p.id,
        values: {
          name: p.name,
          sku: p.sku || '',
          unit: p.unit || 'Kg',
          controlMode: p.controlMode || 'on_demand',
          estimatedCostUsd: p.estimatedCostUsd ?? '',
          stock: p.stock ?? '',
          pricePrincipal: p.prices?.Principal ?? p.priceUsd ?? '',
          priceMayor: p.prices?.Mayor ?? p.priceUsd ?? '',
          supplierName: p.supplierName || ''
        }
      };
      render();
    });
  });
  document.querySelector('[data-action="new-payable"]')?.addEventListener('click', () => {
    editModal = { kind: 'payable', id: null, values: { supplierName: '', concept: '', totalUsd: '', dueDate: defaultCreditDue(), note: '' } };
    render();
  });

  // Mensajeria
  document.querySelectorAll('[data-msg-segment]').forEach((button) => {
    button.addEventListener('click', () => {
      messagingSegment = button.dataset.msgSegment;
      render();
    });
  });
  document.querySelector('[data-msg-template]')?.addEventListener('change', (event) => {
    setState(() => {
      state.settings.messageTemplates = {
        ...(state.settings.messageTemplates || {}),
        [messagingSegment]: event.target.value
      };
    });
  });
  document.querySelector('[data-msg-reset]')?.addEventListener('click', () => {
    setState(() => {
      const t = { ...(state.settings.messageTemplates || {}) };
      delete t[messagingSegment];
      state.settings.messageTemplates = t;
    });
  });
  document.querySelectorAll('[data-send-msg]').forEach((button) => {
    button.addEventListener('click', () => sendSegmentMessage(Number(button.dataset.sendMsg)));
  });
  document.querySelectorAll('[data-copy-msg]').forEach((button) => {
    button.addEventListener('click', () => sendSegmentMessage(Number(button.dataset.copyMsg), { copyOnly: true }));
  });

  // Respaldo: descarga y restauracion del sistema completo.
  document.querySelector('[data-action="export-backup"]')?.addEventListener('click', () => {
    const payload = { app: 'veggies-ccs', exportedAt: new Date().toISOString(), data: serializeState(state) };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `respaldo-veggies-${todayIso()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.querySelector('[data-action="import-backup"]')?.addEventListener('click', () => {
    document.querySelector('[data-import-file]')?.click();
  });
  document.querySelector('[data-import-file]')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      // Acepta ambos formatos: el respaldo del boton ({app, data:{...}}) y un
      // volcado crudo de localStorage ({"scv.phase1.products": "...", ...}).
      let data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
      if (data && typeof data === 'object' && Object.keys(data).some((k) => k.startsWith('scv.phase1.'))) {
        const mapped = {};
        STATE_KEYS.forEach((key) => {
          const raw = data[`scv.phase1.${key}`];
          if (raw !== undefined) {
            try {
              mapped[key] = JSON.parse(raw);
            } catch {
              /* valor corrupto: se omite */
            }
          }
        });
        data = mapped;
      }
      if (!data || typeof data !== 'object' || !Array.isArray(data.products)) {
        throw new Error('El archivo no parece un respaldo del sistema.');
      }
      const resumen = `${(data.orders || []).length} ventas · ${(data.receivables || []).length} creditos · ${(data.payables || []).length} cuentas por pagar · ${(data.customers || []).length} clientes`;
      const ok = window.confirm(
        `Restaurar respaldo${parsed.exportedAt ? ` del ${new Date(parsed.exportedAt).toLocaleString('es-VE')}` : ''}\n(${resumen})\n\nReemplaza los datos de este equipo y de la nube con los del archivo. ¿Continuar?`
      );
      if (!ok) return;
      hydrateState(state, data);
      if (!state.paymentMethods.find((m) => m.id === selectedPaymentMethod)) {
        selectedPaymentMethod = state.paymentMethods[0]?.id ?? null;
      }
      currentOrder = {
        ...currentOrder,
        orderNumber: nextOrderNumber(),
        exchangeRate: state.settings.exchangeRate
      };
      persistState(state);
      scheduleCloudPush();
      render();
      window.alert('Respaldo restaurado en este equipo. Si estas logueado, se esta subiendo a la nube ahora.');
    } catch (err) {
      window.alert(`No se pudo restaurar: ${err?.message || err}`);
    } finally {
      event.target.value = '';
    }
  });

  // Configuracion: auto-guardado al salir de cada campo.
  document.querySelectorAll('[data-set-field]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.setField;
      const value = input.value;
      setState(() => {
        if (key === 'bsStep') {
          state.settings.bsRounding = { ...(state.settings.bsRounding || { mode: 'nearest' }), step: Math.max(0, Number(value || 0)) };
        } else if (key === 'bsMode') {
          state.settings.bsRounding = { ...(state.settings.bsRounding || { step: 0 }), mode: value };
        } else if (key === 'creditDays' || key === 'importMarginPct') {
          state.settings[key] = Math.max(0, Number(value || 0));
          if (key === 'importMarginPct') importState.marginPct = state.settings[key];
        } else {
          state.settings[key] = value;
        }
      });
    });
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      activeView = button.dataset.view;
      selectedAccountId = null;
      render();
      if (activeView === 'weborders') fetchWebOrders();
    });
  });

  document.querySelectorAll('[data-section]').forEach((button) => {
    button.addEventListener('click', () => {
      const sec = SECTIONS.find((s) => s.key === button.dataset.section);
      if (!sec) return;
      // Si ya estas en esa seccion, no cambies de sub-vista; solo entra a su primera vista.
      const inSection = sec.views.some(([v]) => v === activeView);
      if (!inSection) {
        activeView = sec.views[0][0];
        selectedAccountId = null;
        render();
        if (activeView === 'weborders') fetchWebOrders();
      }
    });
  });

  document.querySelector('[data-action="refresh-weborders"]')?.addEventListener('click', fetchWebOrders);
  document.querySelectorAll('[data-load-weborder]').forEach((b) =>
    b.addEventListener('click', () => loadWebOrderToSystem(b.dataset.loadWeborder))
  );
  document.querySelectorAll('[data-dismiss-weborder]').forEach((b) =>
    b.addEventListener('click', () => dismissWebOrder(b.dataset.dismissWeborder))
  );

  document.querySelectorAll('[data-product-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const product = state.products.find((item) => item.id === button.dataset.productId);
      const priced = { ...product, priceUsd: productPrice(product, currentOrder.channel) };
      currentOrder = addItemToOrder(currentOrder, priced, 1);
      render();
    });
  });

  // Cantidad / costo / precio de linea: edicion FLUIDA.
  // 'input' actualiza memoria y totales en sitio (sin re-render: no se pierde el
  // foco ni el decimal a mitad de tecleo, y un 0 transitorio no borra la fila).
  // 'change' (Enter/salir del campo) hace el commit con re-render y persistencia.
  document.querySelectorAll('[data-item-qty]').forEach((input) => {
    input.addEventListener('input', () => {
      patchOrderItem(input.dataset.itemQty, { quantity: Math.max(0, Number(input.value || 0)) });
      updateOrderTotalsInPlace();
    });
    input.addEventListener('change', () => {
      currentOrder = updateOrderItemQuantity(currentOrder, input.dataset.itemQty, input.value);
      render();
    });
  });
  document.querySelectorAll('[data-item-price]').forEach((input) => {
    input.addEventListener('input', () => {
      patchOrderItem(input.dataset.itemPrice, { priceUsd: Math.max(0, Number(input.value || 0)) });
      updateOrderTotalsInPlace();
    });
    input.addEventListener('change', () => {
      patchOrderItem(input.dataset.itemPrice, { priceUsd: roundMoney(Math.max(0, Number(input.value || 0))) });
      render();
    });
  });
  document.querySelectorAll('[data-item-cost]').forEach((input) => {
    input.addEventListener('input', () => {
      patchOrderItem(input.dataset.itemCost, { estimatedCostUsd: Math.max(0, Number(input.value || 0)) });
      updateOrderTotalsInPlace();
    });
    input.addEventListener('change', () => {
      const cost = roundMoney(Math.max(0, Number(input.value || 0)));
      const item = currentOrder.items.find((i) => i.id === input.dataset.itemCost);
      patchOrderItem(input.dataset.itemCost, { estimatedCostUsd: cost });
      // El ultimo costo se guarda en el catalogo para las proximas ventas.
      if (item?.productId) {
        setState(() => {
          state.products = state.products.map((p) =>
            p.id === item.productId ? { ...p, estimatedCostUsd: cost } : p
          );
        });
      } else {
        render();
      }
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
      if (paymentMode !== 'mixto') mixedAmounts = {};
      render();
    });
  });
  document.querySelectorAll('[data-mixed-amount]').forEach((input) => {
    input.addEventListener('input', (event) => {
      mixedAmounts = { ...mixedAmounts, [input.dataset.mixedAmount]: event.target.value };
      render();
    });
  });
  document.querySelector('[data-credit-due]')?.addEventListener('change', (event) => {
    creditDueDate = event.target.value;
    render();
  });
  document.querySelectorAll('[data-mixed-fill]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.mixedFill;
      const totalUsd = calculateOrderTotals(currentOrder).totalUsd;
      const others = mixablePaymentMethods().reduce(
        (sum, m) => (m.id === id ? sum : sum + parseAmount(mixedAmounts[m.id])),
        0
      );
      const fill = roundMoney(Math.max(0, Number(totalUsd || 0) - others));
      mixedAmounts = { ...mixedAmounts, [id]: fill ? String(fill) : '' };
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
    const ok = window.confirm(
      'Esto borra los datos guardados en ESTE equipo y recarga la pagina.\n\n' +
        'Si la sincronizacion esta activa, el sistema se restaurara desde la nube ' +
        '(tendras que iniciar sesion de nuevo).\n\n¿Continuar?'
    );
    if (!ok) return;
    localStorage.clear();
    location.reload();
  });
  document.querySelector('[data-action="logout"]')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.href = '/admin/';
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
    scheduleCloudPush();
    render();
    return;
  }
  persistState(state);
  scheduleCloudPush();
  render();
}

function finalizeCurrentOrder() {
  const isCredit = paymentMode === 'credito';
  const isMixed = paymentMode === 'mixto';
  if (isCredit && !currentOrder.customerId) {
    window.alert('Selecciona un cliente del sistema para registrar el credito.');
    return;
  }

  const totals = calculateOrderTotals(currentOrder);

  if (isMixed && !mixedCovered(totals.totalUsd)) {
    window.alert('El pago mixto no cubre el total del pedido.');
    return;
  }

  // Parciales del pago mixto: uno por cada metodo (real) con monto > 0.
  const splits = isMixed
    ? mixablePaymentMethods()
        .filter((m) => parseAmount(mixedAmounts[m.id]) > 0)
        .map((m) => ({
          methodId: m.id,
          methodName: m.name,
          accountId: m.accountId,
          currency: m.currency,
          amountUsd: parseAmount(mixedAmounts[m.id])
        }))
    : null;

  const singleMethod = isCredit
    ? { id: 'credito', name: 'Credito', currency: 'USD', accountId: null }
    : state.paymentMethods.find((item) => item.id === selectedPaymentMethod) || state.paymentMethods[0];

  const paid = finalizeOrder(currentOrder, {
    methodId: isMixed ? 'mixto' : singleMethod.id,
    methodName: isMixed ? 'Mixto' : singleMethod.name,
    amountUsd: totals.totalUsd,
    reference: '',
    credit: isCredit,
    splits
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
      state.receivables = [
        createReceivable({ order: paid, customer, dueDate: creditDueDate || null }),
        ...state.receivables
      ];
    } else if (isMixed) {
      // Pago mixto: un movimiento de caja por cada parcial, a su cuenta destino.
      const movements = (paid.payment.splits || []).map((s) => {
        const amount =
          s.currency === 'VES' ? applyBsRounding(s.amountVes, state.settings.bsRounding) : s.amountUsd;
        // Refleja en el parcial el Bs realmente abonado (para una reversa exacta).
        if (s.currency === 'VES') s.amountVes = amount;
        return createPaymentMovement({
          accountId: s.accountId,
          orderId: paid.id,
          orderNumber: paid.orderNumber,
          amount,
          currency: s.currency,
          methodName: s.methodName
        });
      });
      state.accountMovements = [...movements, ...state.accountMovements];
      state.accounts = applyMovements(state.accounts, movements);
    } else {
      const accountAmount = singleMethod.currency === 'VES' ? roundedVes : paid.payment.amountUsd;
      const paymentMovement = createPaymentMovement({
        accountId: singleMethod.accountId,
        orderId: paid.id,
        orderNumber: paid.orderNumber,
        amount: accountAmount,
        currency: singleMethod.currency === 'VES' ? 'VES' : 'USD',
        methodName: singleMethod.name
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
    mixedAmounts = {};
    creditDueDate = defaultCreditDue();
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

// Migracion unica: linea PM (sprays Zonatov) al catalogo + sus 2 cuentas por
// pagar. Idempotente (compara por sku/id): corre en cualquier equipo aunque ya
// tenga datos guardados, y el cambio se sube a la nube.
function ensurePmData() {
  let changed = false;
  const missing = PM_PRODUCTS.filter((p) => !state.products.some((x) => x.sku === p.sku));
  if (missing.length) {
    state.products = [...state.products, ...missing];
    changed = true;
  }
  PM_PAYABLES.forEach((pay) => {
    if (!state.payables.some((x) => x.id === pay.id)) {
      state.payables = [pay, ...state.payables];
      changed = true;
    }
  });
  return changed;
}

// Registro de proveedores: se alimenta de productos y cuentas por pagar ya
// existentes, y canoniza los nombres de las cuentas legacy para que la vista
// agrupe de verdad por proveedor.
function ensureSuppliers() {
  if (!Array.isArray(state.suppliers)) state.suppliers = [];
  let changed = false;
  const addIfNew = (rawName) => {
    const name = String(rawName || '').trim();
    if (!name || findSupplierMatch(state.suppliers, name)) return;
    state.suppliers = [...state.suppliers, createSupplier({ name })];
    changed = true;
  };
  state.products.forEach((p) => addIfNew(p.supplierName));
  state.payables.forEach((p) => addIfNew(p.supplierName));
  let payChanged = false;
  const canon = state.payables.map((p) => {
    const m = findSupplierMatch(state.suppliers, p.supplierName);
    if (m && (p.supplierName !== m.name || p.supplierId !== m.id)) {
      payChanged = true;
      return { ...p, supplierName: m.name, supplierId: m.id };
    }
    return p;
  });
  if (payChanged) {
    state.payables = canon;
    changed = true;
  }
  return changed;
}

// Las migraciones de arranque se guardan SOLO en este equipo, sin marcar la
// nube como "pendiente de subir": son deterministas (todos los equipos las
// aplican igual) y marcarlas hacia que un equipo recien abierto SUBIERA su
// copia semilla encima de la nube buena en vez de bajarla.
{
  const migrated = ensurePmData();
  const migratedSuppliers = ensureSuppliers();
  if (migrated || migratedSuppliers) persistState(state);
}

// Devuelve el proveedor canonico para un nombre escrito a mano: si ya existe
// uno igual o parecido lo reutiliza; si no, lo crea y lo guarda en el registro.
// (Debe llamarse dentro de un setState: muta state.suppliers.)
function resolveSupplier(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return { id: null, name: 'Proveedor' };
  const match = findSupplierMatch(state.suppliers, name);
  if (match) return { id: match.id, name: match.name };
  const created = createSupplier({ name });
  state.suppliers = [...state.suppliers, created];
  return created;
}

render();
// Arranca la sincronizacion en la nube despues del primer render (no bloquea el
// arranque) y, al terminar, refresca la tasa BCV del dia (respeta una tasa
// manual fijada hoy). El orden evita que el estado adoptado pise la tasa fresca.
initCloudSync().finally(() => autoRefreshBcv());
