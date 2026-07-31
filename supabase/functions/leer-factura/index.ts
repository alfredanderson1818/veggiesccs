// ============================================================================
//  LEER FACTURA CON IA — Supabase Edge Function
//
//  Recibe la foto de una factura (base64), la manda a Claude (Anthropic) y
//  devuelve la factura estructurada: proveedor, fecha, vencimiento, tipo de
//  pago, renglones (codigo, descripcion, cantidad, precio, total), descuento
//  y totales. La clave de la API vive aqui como secreto — nunca en el sitio.
//
//  Seguridad: solo usuarios AUTENTICADOS (admins logueados). El rol anon se
//  rechaza aunque el JWT sea valido.
//
//  Como desplegarla (una vez):
//   1. Supabase → Edge Functions → Deploy new function → via Editor
//      Nombre: leer-factura  ·  pega este archivo completo  ·  Deploy
//      (deja activado "Verify JWT with legacy secret" / Enforce JWT)
//   2. Supabase → Edge Functions → Secrets → Add new secret
//      Nombre: ANTHROPIC_API_KEY   Valor: tu clave de console.anthropic.com
// ============================================================================
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Esquema de salida: la API garantiza que la respuesta cumple esta forma.
const INVOICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "proveedor",
    "numeroDocumento",
    "fecha",
    "vencimiento",
    "tipoPago",
    "items",
    "descuentoPct",
    "subtotal",
    "totalPagar",
    "observaciones",
  ],
  properties: {
    proveedor: { type: ["string", "null"], description: "Nombre del proveedor/emisor" },
    numeroDocumento: { type: ["string", "null"], description: "Numero de factura o nota" },
    fecha: { type: ["string", "null"], description: "Fecha de emision en formato YYYY-MM-DD" },
    vencimiento: { type: ["string", "null"], description: "Fecha de vencimiento en YYYY-MM-DD, si aparece" },
    tipoPago: {
      type: ["string", "null"],
      description: "CONTADO, CREDITO u otro texto tal como aparece",
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["codigo", "descripcion", "cantidad", "unidad", "precioUnitario", "total"],
        properties: {
          codigo: { type: ["string", "null"] },
          descripcion: { type: "string" },
          cantidad: { type: "number" },
          unidad: { type: ["string", "null"], description: "KG, UND, CAJA... si aparece" },
          precioUnitario: { type: "number" },
          total: { type: "number" },
        },
      },
    },
    descuentoPct: {
      type: ["number", "null"],
      description: "Porcentaje de descuento global si la factura lo aplica (ej: 20)",
    },
    subtotal: { type: ["number", "null"] },
    totalPagar: { type: ["number", "null"], description: "Total final a pagar" },
    observaciones: {
      type: ["string", "null"],
      description: "Cualquier dato importante que no encaje en los demas campos",
    },
  },
};

const PROMPT = `Lee esta factura o nota de despacho de un proveedor venezolano y extrae los datos EXACTAMENTE como aparecen impresos.

Reglas:
- Extrae TODOS los renglones de productos, sin saltarte ninguno, en el mismo orden.
- Los numeros van como numeros (usa punto decimal). No inventes valores: si algo no aparece, dejalo en null.
- Si hay un descuento global (%), reportalo en descuentoPct; NO lo apliques tu a los precios unitarios — deja los precios tal como estan impresos.
- Las fechas en formato YYYY-MM-DD (en Venezuela las facturas suelen venir DD/MM/YYYY).
- "Nota de despacho", "factura" o "recibo": trata todos igual.
- Si un renglon es un obsequio o exhibidor con precio 0, inclUYELO igual.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---- Solo admins logueados (el rol anon se rechaza) ----
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } },
    );
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(
        JSON.stringify({ error: "Inicia sesion para usar la lectura con IA." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { image, mediaType } = await req.json();
    if (!image || typeof image !== "string") {
      return new Response(JSON.stringify({ error: "Falta la imagen." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Falta configurar ANTHROPIC_API_KEY en los secretos de Supabase." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 16000,
      output_config: { format: { type: "json_schema", schema: INVOICE_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType || "image/jpeg",
                data: image,
              },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return new Response(
        JSON.stringify({ error: "La IA no pudo procesar esta imagen." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (response.stop_reason === "max_tokens") {
      return new Response(
        JSON.stringify({ error: "La factura es demasiado larga; intenta por partes." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const textBlock = response.content.find((b: { type: string }) => b.type === "text");
    const invoice = JSON.parse((textBlock as { text: string }).text);

    return new Response(JSON.stringify({ invoice }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("credit balance") ? 402 : 500;
    return new Response(
      JSON.stringify({
        error: status === 402
          ? "Se acabo el credito de la API de Anthropic. Recarga en console.anthropic.com."
          : `Error leyendo la factura: ${message}`,
      }),
      { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
