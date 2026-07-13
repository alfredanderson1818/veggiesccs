// Registro de proveedores: nombres canonicos para unificar cuentas por pagar.
// "zonatov" o "Importadora Zonatov" deben caer en el MISMO proveedor guardado.

export function normalizeSupplierKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // sin acentos
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[n];
}

// Busca un proveedor existente que coincida con `name`:
// 1) igual normalizado, 2) uno contiene al otro (>=4 letras), 3) muy parecido
// (Levenshtein >= 0.75). Devuelve el proveedor o null.
export function findSupplierMatch(suppliers, name) {
  const key = normalizeSupplierKey(name);
  if (!key) return null;
  const list = Array.isArray(suppliers) ? suppliers : [];

  let hit = list.find((s) => normalizeSupplierKey(s.name) === key);
  if (hit) return hit;

  if (key.length >= 4) {
    hit = list.find((s) => {
      const k = normalizeSupplierKey(s.name);
      return k.length >= 4 && (k.includes(key) || key.includes(k));
    });
    if (hit) return hit;
  }

  let best = null;
  let bestScore = 0;
  list.forEach((s) => {
    const k = normalizeSupplierKey(s.name);
    if (!k) return;
    const score = 1 - levenshtein(key, k) / Math.max(key.length, k.length);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  });
  return bestScore >= 0.75 ? best : null;
}

export function createSupplier({ name }) {
  return {
    id: `sup-${crypto.randomUUID().slice(0, 8)}`,
    name: String(name || '').trim() || 'Proveedor'
  };
}
