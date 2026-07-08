// ============================================================================
//  SINCRONIZACION EN LA NUBE (Supabase)
//  Guarda TODO el estado del negocio como un unico documento JSON en la tabla
//  `business_state`, para que se comparta entre dispositivos y no se pierda.
//
//  Estrategia:
//   - La app arranca al instante desde localStorage (rapido y funciona offline).
//   - Al abrir: baja el remoto; si es mas nuevo lo adopta, si no, sube el local.
//   - Cada cambio local se sube con "debounce" (espera breve para agrupar).
//   - Se escuchan cambios de otros dispositivos por realtime.
//   - La VERSION es `updated_at`, asignada por el SERVIDOR (trigger now()). Al ser
//     un reloj monotono unico para todos, el orden es determinista y los
//     dispositivos CONVERGEN al mismo estado (last-write-wins sin divergencia).
//   - `client_id` identifica el origen para ignorar el eco de mis propios cambios.
//
//  Seguridad: la tabla solo la leen/escriben usuarios autenticados (los admins
//  logueados). El sitio publico (anon) no tiene acceso (ver business_state.sql).
// ============================================================================
import { supabase, BUSINESS_ID } from '../supabase/client.mjs';

const TABLE = 'business_state';
const CLIENT_ID_KEY = 'scv.clientId';
const SYNCED_AT_KEY = 'scv.cloudSyncedAt';

// Id estable por navegador (para ignorar el eco de mis propios cambios).
export function getClientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return 'anon';
  }
}

// Ultima version (updated_at del servidor) que este dispositivo aplico/subio.
export function getSyncedAt() {
  try {
    return localStorage.getItem(SYNCED_AT_KEY) || null;
  } catch {
    return null;
  }
}

export function setSyncedAt(ts) {
  try {
    if (ts) localStorage.setItem(SYNCED_AT_KEY, ts);
  } catch {
    /* almacenamiento no disponible */
  }
}

// Compara dos marcas de tiempo ISO; true si `a` es estrictamente mas nueva que `b`.
export function isNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  return new Date(a).getTime() > new Date(b).getTime();
}

// Descarga el estado remoto. Devuelve { data, updatedAt, clientId } o null.
export async function pullRemoteState() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('data, updated_at, client_id')
    .eq('business_id', BUSINESS_ID)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    data: data.data || {},
    updatedAt: data.updated_at || null,
    clientId: data.client_id || null
  };
}

// Sube el estado completo (upsert). El servidor asigna updated_at (trigger),
// que leemos de vuelta para saber nuestra version. Devuelve el updated_at server.
export async function pushRemoteState(stateData) {
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(
      {
        business_id: BUSINESS_ID,
        data: stateData,
        client_id: getClientId()
      },
      { onConflict: 'business_id' }
    )
    .select('updated_at')
    .single();
  if (error) throw error;
  return data?.updated_at || null;
}

// Escucha cambios de la fila del negocio (otros dispositivos/admins).
// `onChange({ data, updatedAt, clientId })` se llama en cada insert/update.
export function subscribeRemoteState(onChange) {
  return supabase
    .channel(`business_state:${BUSINESS_ID}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: TABLE, filter: `business_id=eq.${BUSINESS_ID}` },
      (payload) => {
        const row = payload.new;
        if (!row) return;
        onChange({
          data: row.data || {},
          updatedAt: row.updated_at || null,
          clientId: row.client_id || null
        });
      }
    )
    .subscribe();
}
