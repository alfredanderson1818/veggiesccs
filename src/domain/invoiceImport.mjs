import { roundMoney } from './money.mjs';

// Importacion de facturas / notas de entrega del proveedor.
// Parsea el texto (OCR o pegado) en renglones y construye una pre-factura editable.
// El precio del proveedor se interpreta como COSTO; el precio de venta se calcula con margen.

const UNIT_TOKENS = ['KG', 'KGS', 'UND', 'UNI', 'UNID', 'GR', 'GRS', 'LT', 'LTS', 'DOC', 'PZA', 'PZ', 'SACO', 'CAJA', 'BULTO', 'MALLA', 'ATADO'];
const UNIT_REGEX = new RegExp(`\\b(${UNIT_TOKENS.join('|')})\\b`, 'i');
const SKIP_REGEX = /DESCRIPCION|COND\.?\s*PAGO|NOTA DE ENTREGA|R\.?\s*I\.?\s*F|NOMBRE DE|CLIENTE|ORIGEN|TOTAL\s*USD|^TTL|FECHA|CONTADO|P\.?\/?\s*UNI|SUBTOTAL|^TOTAL\b/i;

export function normalizeUnit(unit) {
  const key = (unit || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (['KG', 'KGS'].includes(key)) return 'Kg';
  if (['UND', 'UNI', 'UNID', 'U'].includes(key)) return 'Und';
  if (['GR', 'GRS'].includes(key)) return 'Gr';
  if (['LT', 'LTS'].includes(key)) return 'Lt';
  if (!key) return 'Und';
  return key.charAt(0) + key.slice(1).toLowerCase();
}

const NUMBER_REGEX = /\d+(?:[.,]\d+)?/g;
const toNumber = (raw) => Number(String(raw).replace(',', '.'));
const hasRealWord = (text) => /[\p{L}]{3,}/u.test(text || '');

// Parsea una linea: nombre + 2-3 numeros al final (CANT, P/UNI, TOTAL).
// NO exige que la unidad "KG/UNI" se lea bien (el OCR suele destrozarla):
// si no la encuentra, asume Kg. La descripcion puede venir vacia (formato
// de dos lineas); parseInvoiceText la completa con la linea anterior.
export function parseInvoiceLine(line) {
  const clean = line.replace(/\s+/g, ' ').trim();
  if (!clean || SKIP_REGEX.test(clean)) return null;

  const numbers = [...clean.matchAll(NUMBER_REGEX)];
  if (numbers.length < 2) return null;

  // Las columnas son los ultimos 2-3 numeros de la linea (lo de antes es el nombre).
  const block = numbers.slice(-3);
  const firstNumberIndex = block[0].index;

  const unitMatch = clean.match(UNIT_REGEX);
  const descEnd = unitMatch && unitMatch.index < firstNumberIndex ? unitMatch.index : firstNumberIndex;
  const description = clean
    .slice(0, descEnd)
    .replace(/[^\p{L}\p{N}\s#]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const quantity = roundMoney(toNumber(block[0][0]));
  const unitCostUsd = roundMoney(toNumber(block[1][0]));
  const totalUsd = block.length >= 3 ? roundMoney(toNumber(block[2][0])) : roundMoney(quantity * unitCostUsd);

  if (quantity < 0 || unitCostUsd < 0) return null;

  return { description, unit: unitMatch ? normalizeUnit(unitMatch[0]) : 'Kg', quantity, unitCostUsd, totalUsd };
}

function looksLikeDescription(line) {
  // Tiene una palabra real (>=3 letras) y no es un encabezado conocido.
  return !SKIP_REGEX.test(line) && hasRealWord(line);
}

export function parseInvoiceText(text) {
  const items = [];
  let pendingDescription = '';
  for (const raw of (text || '').split(/\r?\n/)) {
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (!clean) continue;

    const item = parseInvoiceLine(clean);
    if (item) {
      const description = hasRealWord(item.description) ? item.description : pendingDescription;
      pendingDescription = '';
      if (!hasRealWord(description)) continue; // sin un nombre real, no es un renglon util
      items.push({ ...item, description });
    } else if (looksLikeDescription(clean)) {
      // Nombre de producto cuya fila de numeros viene en la siguiente linea.
      pendingDescription = clean.replace(/[.\-:_·]+$/g, '').trim();
    }
  }
  return items;
}

export function suggestSalePrice(unitCostUsd, marginPct) {
  return roundMoney(Number(unitCostUsd || 0) * (1 + Number(marginPct || 0) / 100));
}

function normalizeName(value) {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Limpia para comparar: quita acentos, simbolos, digitos y tokens de 1 letra
// (ruido tipico de OCR como "a", "i", "|"), y compacta sin espacios.
// "AGUA CATE" -> "aguacate", "7 MELCN" -> "melcn", "a i TOM TE" -> "tomte"
export function cleanForMatch(value) {
  return normalizeName(value)
    .split(' ')
    .filter((token) => token.replace(/[0-9]/g, '').length > 1)
    .join('')
    .replace(/[0-9]/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = temp;
    }
  }
  return prev[b.length];
}

export function matchScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Una contiene a la otra (maneja prefijos de ruido del OCR)
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return 0.9;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

export function matchProduct(description, products, minScore = 0.6) {
  const target = cleanForMatch(description);
  if (target.length < 3) return null;
  let best = null;
  let bestScore = 0;
  for (const product of products) {
    if (product.controlMode === 'service') continue;
    const score = matchScore(target, cleanForMatch(product.name));
    if (score > bestScore) {
      bestScore = score;
      best = product;
    }
  }
  return bestScore >= minScore ? best : null;
}

export function buildPreInvoiceRows(items, { marginPct = 30, products = [] } = {}) {
  return items.map((item) => {
    const matched = matchProduct(item.description, products);
    if (matched) {
      // Vinculado al catalogo: jala nombre, SKU, costo y precio del catalogo.
      const price = roundMoney(matched.prices?.Principal ?? matched.priceUsd ?? 0);
      const cost = roundMoney(matched.estimatedCostUsd ?? item.unitCostUsd ?? 0);
      return {
        description: matched.name,
        sku: matched.sku || '',
        unit: matched.unit || item.unit,
        quantity: item.quantity,
        unitCostUsd: cost,
        marginPct: cost > 0 ? roundMoney((price / cost - 1) * 100) : marginPct,
        priceUsd: price,
        productId: matched.id,
        controlMode: matched.controlMode || 'on_demand',
        supplierName: matched.supplierName || '',
        matched: true,
        ocrText: item.description
      };
    }
    return {
      description: item.description,
      sku: '',
      unit: item.unit,
      quantity: item.quantity,
      unitCostUsd: item.unitCostUsd,
      marginPct,
      priceUsd: suggestSalePrice(item.unitCostUsd, marginPct),
      productId: null,
      controlMode: 'on_demand',
      supplierName: '',
      matched: false,
      ocrText: item.description
    };
  });
}

export function preInvoiceTotals(rows) {
  const costUsd = roundMoney(rows.reduce((sum, r) => sum + Number(r.quantity || 0) * Number(r.unitCostUsd || 0), 0));
  const saleUsd = roundMoney(rows.reduce((sum, r) => sum + Number(r.quantity || 0) * Number(r.priceUsd || 0), 0));
  return { costUsd, saleUsd, marginUsd: roundMoney(saleUsd - costUsd) };
}
