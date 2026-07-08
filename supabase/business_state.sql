-- ============================================================================
--  SINCRONIZACION DEL SISTEMA — tabla business_state
--  Corre esto UNA vez en Supabase -> SQL Editor -> New query -> Run.
--  Guarda todo el estado del negocio (productos, ventas, cuentas, clientes...)
--  como un unico documento JSON compartido entre los dispositivos de los admins.
--
--  Es idempotente y auto-reparable: si ya existe una tabla business_state a
--  medias (de un intento anterior), le agrega las columnas que falten y limpia
--  las politicas viejas. Se puede volver a correr sin problema.
--
--  La VERSION es `updated_at`, que asigna el SERVIDOR (trigger de abajo). Como es
--  un reloj unico para todos, los dispositivos convergen al mismo estado.
--
--  ⚠️ SEGURIDAD IMPORTANTE: estas politicas permiten leer/escribir a cualquier
--  usuario AUTENTICADO. Como el sistema solo debe tener cuentas de admin, ve a
--     Supabase -> Authentication -> Sign In / Providers -> Email
--  y DESACTIVA "Allow new users to sign up".
--  Asi nadie puede auto-registrarse; solo entran los usuarios que TU crees a mano
--  (Authentication -> Users -> Add user), que son los unicos que veran costos y
--  datos de clientes. El sitio publico (anon) nunca tiene acceso a esta tabla.
-- ============================================================================

-- 1) Tabla + columnas (agrega solo lo que falte).
create table if not exists public.business_state (
  business_id text primary key
);
alter table public.business_state add column if not exists data       jsonb       not null default '{}'::jsonb;
alter table public.business_state add column if not exists rev        bigint      not null default 0;
alter table public.business_state add column if not exists client_id  text;
alter table public.business_state add column if not exists updated_at timestamptz not null default now();

-- 2) Trigger: el servidor pone updated_at = now() en cada insert/update.
--    Asi la "version" no depende del reloj de cada dispositivo.
create or replace function public.business_state_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists business_state_touch on public.business_state;
create trigger business_state_touch
  before insert or update on public.business_state
  for each row execute function public.business_state_touch();

-- 3) Seguridad por filas.
alter table public.business_state enable row level security;

-- Limpia TODAS las politicas previas de la tabla (por si quedo alguna abierta).
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'business_state'
  loop
    execute format('drop policy if exists %I on public.business_state', pol.policyname);
  end loop;
end $$;

-- Solo usuarios autenticados (admins logueados). Ver el aviso de signups arriba.
create policy "bs_select_auth"
  on public.business_state for select
  to authenticated using (true);

create policy "bs_insert_auth"
  on public.business_state for insert
  to authenticated with check (true);

create policy "bs_update_auth"
  on public.business_state for update
  to authenticated using (true) with check (true);

-- 4) Realtime: para que un cambio en un equipo se vea en el otro al instante.
--    (Si ya estaba agregada, ignora el error "already member of publication".)
do $$
begin
  alter publication supabase_realtime add table public.business_state;
exception when duplicate_object then null;
end $$;
