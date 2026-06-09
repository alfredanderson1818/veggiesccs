// ============================================================================
//  CONFIGURACION DE SUPABASE
//  Pega aqui los 2 datos de tu proyecto:
//  Supabase -> Project Settings -> Data API (o API):
//    - Project URL
//    - anon / public key   (es publica, va en el front; la seguridad la dan las
//                            politicas RLS + el login)
// ============================================================================

export const SUPABASE_URL = 'https://xultcqzbuknhqbpmpoks.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1bHRjcXpidWtuaHFicG1wb2tzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTY0MjYsImV4cCI6MjA5NjUzMjQyNn0.XE3zUqk03H-XOt7cnLjuJE9LZSsG9Dh_0Qxil7noPAA';

// Un solo negocio por ahora.
export const BUSINESS_ID = 'veggies-ccs';
