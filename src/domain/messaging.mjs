// Mensajeria: utilidades puras para avisos a clientes por WhatsApp.
// El envio es "asistido" (abre wa.me con el texto listo); esta capa solo
// normaliza telefonos y rellena plantillas — la misma que usaria una API
// oficial de WhatsApp si se conecta despues.

// Normaliza un telefono venezolano al formato internacional que exige wa.me
// (58 + 10 digitos, sin '+'). Devuelve null si no parece un movil valido.
//   "0412-919.04 59" -> "584129190459"
//   "58 424 2244622"  -> "584242244622"
//   "+58412..."       -> "58412..."
export function normalizePhoneVE(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  let rest = null;
  if (digits.startsWith('58') && digits.length === 12) rest = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 11) rest = digits.slice(1);
  else if (digits.length === 10) rest = digits;
  if (!rest || rest.length !== 10 || !rest.startsWith('4')) return null;
  return `58${rest}`;
}

// Rellena una plantilla con variables {nombre}, {saldo}, etc.
// Las variables sin valor se quitan del texto (no dejan "{x}" colgando).
export function fillTemplate(template, vars = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) =>
    vars[key] === undefined || vars[key] === null ? '' : String(vars[key])
  );
}

// Enlace de WhatsApp listo para abrir.
export function waLink(phone, text) {
  const normalized = normalizePhoneVE(phone);
  if (!normalized) return null;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(text || '')}`;
}

// Plantillas por defecto de cada tipo de aviso (editables en el modulo).
export const DEFAULT_TEMPLATES = {
  cobranza:
    'Buenos dias {nombre} 👋 Te saluda Veggies CCS. Te recordamos tu saldo pendiente de {saldo}{vencidoTxt}. ¿Coordinamos el pago? ¡Gracias!',
  pedido:
    'Hola {nombre} 👋 Tu pedido #{pedido} en Veggies CCS esta confirmado por {total}. Te avisamos cuando vaya en camino. ¡Gracias por tu compra! 🥬',
  precios:
    'Hola {nombre} 👋 ¡Llego mercancia fresca a Veggies CCS! 🥬🍅 Haz tu pedido en https://www.veggiesccs.com/pedidos y te lo llevamos a domicilio.',
  dormidos:
    'Hola {nombre} 👋 ¡Te extranamos en Veggies CCS! Tenemos frutas y verduras frescas con delivery en Caracas. Pide facil en https://www.veggiesccs.com/pedidos 🥑'
};
