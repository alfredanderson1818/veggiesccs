// Linea PM (sprays de pintura y automotriz) — Importadora Zonatov 18, C.A.
// Origen: notas de despacho 0008551 y A0008550 del 13/07/2026 (credito, vence 03/08/2026).
// Costo = precio de lista con el 20% de descuento de la nota ya aplicado.
// Precios de venta sugeridos: detal = costo x1.30, mayor = costo x1.20 (editables en Catalogo).

const SUPPLIER = { supplierId: 'sup-zonatov', supplierName: 'Importadora Zonatov 18' };

function pm(sku, name, cost, { stock = 12, mode = 'inventory', detal, mayor } = {}) {
  const principal = detal ?? Math.round(cost * 1.3 * 100) / 100;
  const wholesale = mayor ?? Math.round(cost * 1.2 * 100) / 100;
  return {
    id: `p-${sku.toLowerCase()}`,
    sku,
    name,
    unit: 'Und',
    category: 'PM',
    priceUsd: principal,
    prices: { Principal: principal, Mayor: wholesale },
    estimatedCostUsd: cost,
    controlMode: mode,
    stock: mode === 'inventory' ? stock : null,
    ...SUPPLIER
  };
}

export const PM_PRODUCTS = [
  // Nota 0008551
  pm('PM037', 'Pintura Spray Negro Mate 400ml', 1.6),
  pm('PM038', 'Pintura Spray Negro Brillante 400ml', 1.6),
  pm('PM039', 'Pintura Spray Blanco Brillante 400ml', 1.6),
  pm('PM040', 'Pintura Spray Rojo Intenso 400ml', 1.6),
  pm('PM041', 'Pintura Spray Blanco Mate 400ml', 1.6),
  pm('PM043', 'Pintura Spray Transparente 400ml', 1.6),
  pm('PM046', 'Pintura Spray Amarillo Limon 400ml', 1.6),
  pm('PM048', 'Pintura Spray Naranja 400ml', 1.6),
  pm('PM000', 'Exhibidor de Spray', 0, { mode: 'no_inventory', detal: 0, mayor: 0 }),
  // Nota A0008550
  pm('PM042', 'Pintura Spray Aluminio 400ml', 1.6),
  pm('PM044', 'Pintura Spray Azul Rey 400ml', 1.6),
  pm('PM049', 'Pintura Spray Alta Temperatura Negro 400ml', 3.36),
  pm('PM052', 'Limpiacauchos Spray 650ml', 2.4),
  pm('PM053', 'Silicone Limon Spray 450ml', 2),
  pm('PM054', 'Limpiador Multiusos Spray 650ml', 2.08),
  pm('PM055', 'Limpia Contacto Spray 450ml', 2.08),
  pm('PM056', 'Limpia Carburador Spray 450ml', 2.08),
  pm('PM058', 'Lubricante Anti Oxido Spray 450ml', 2.08),
  pm('PM059', 'Removedor de Pintura 400ml', 1.92),
  pm('PM060', 'Stainless Repair Paint 400ml', 3.76),
  pm('PM061', 'Spray Limpiador de Freno y Embrague 650ml', 2.16),
  pm('PM062', 'Desengrasante de Motor 650ml', 1.92),
  pm('PM063', 'Extintor de Incendios 500ml', 2),
  pm('PM064', 'Spray Reflectante Nocturno 450ml', 4.4),
  pm('PM065', 'Sellador e Inflador de Caucho Portatil 450ml', 2.16),
  pm('PM066', 'Pintura Spray Alta Temperatura Silver 400ml', 3.36)
];

// Las dos notas son compras a CREDITO: cuentas por pagar al proveedor.
export const PM_PAYABLES = [
  {
    id: 'pay-zonatov-8551',
    supplierName: 'Importadora Zonatov 18',
    concept: 'Nota de despacho 0008551 (sprays)',
    date: '2026-07-13',
    dueDate: '2026-08-03',
    totalUsd: 153.6,
    note: 'Credito · vendedor Moises Benzaquen',
    sourceOrderId: null,
    payments: [],
    status: 'open',
    createdAt: '2026-07-13T12:00:00.000Z'
  },
  {
    id: 'pay-zonatov-8550',
    supplierName: 'Importadora Zonatov 18',
    concept: 'Nota de despacho A0008550 (sprays y automotriz)',
    date: '2026-07-13',
    dueDate: '2026-08-03',
    totalUsd: 491.52,
    note: 'Credito · vendedor Moises Benzaquen',
    sourceOrderId: null,
    payments: [],
    status: 'open',
    createdAt: '2026-07-13T12:00:00.000Z'
  }
];
