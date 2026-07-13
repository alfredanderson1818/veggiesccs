-- ============================================================================
--  SINCRONIZACION DEL SISTEMA — tabla business_state  (v2, auto-reparable)
--  Corre esto UNA vez en Supabase -> SQL Editor -> New query -> Run.
--
--  v2 arregla el caso de una tabla vieja creada a medias SIN clave unica en
--  business_id: eso hacia fallar TODOS los guardados con el error
--  "there is no unique or exclusion constraint matching the ON CONFLICT
--  specification" (la nube nunca guardo nada). Este script:
--   - si la tabla existe pero esta VACIA, la reconstruye limpia;
--   - si tiene datos, agrega columnas faltantes + indice unico de respaldo;
--   - trigger de updated_at, RLS solo-autenticados y realtime.
--  Es idempotente: se puede correr varias veces sin problema.
--
--  ⚠️ SEGURIDAD: ve a Authentication -> Sign In / Providers -> Email y
--  DESACTIVA "Allow new users to sign up". Solo tus usuarios creados a mano
--  deben poder entrar (esta tabla contiene costos y datos de clientes).
-- ============================================================================

-- 0) Si existe una tabla vieja VACIA (estructura desconocida), se reconstruye.
do $$
declare n bigint;
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'business_state'
  ) then
    execute 'select count(*) from public.business_state' into n;
    if n = 0 then
      drop table public.business_state;
    end if;
  end if;
end $$;

-- 1) Tabla + columnas (agrega solo lo que falte).
create table if not exists public.business_state (
  business_id text primary key,
  data        jsonb       not null default '{}'::jsonb,
  rev         bigint      not null default 0,
  client_id   text,
  updated_at  timestamptz not null default now()
);
alter table public.business_state add column if not exists data       jsonb       not null default '{}'::jsonb;
alter table public.business_state add column if not exists rev        bigint      not null default 0;
alter table public.business_state add column if not exists client_id  text;
alter table public.business_state add column if not exists updated_at timestamptz not null default now();

-- 1b) Respaldo: garantiza la clave unica que necesita el guardado (ON CONFLICT),
--     por si la tabla venia de antes con datos y sin primary key.
create unique index if not exists business_state_business_id_key
  on public.business_state (business_id);

-- 2) Trigger: el servidor pone updated_at = now() en cada insert/update.
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

-- 3) Seguridad por filas: SOLO usuarios autenticados (admins logueados).
alter table public.business_state enable row level security;

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

create policy "bs_select_auth"
  on public.business_state for select
  to authenticated using (true);

create policy "bs_insert_auth"
  on public.business_state for insert
  to authenticated with check (true);

create policy "bs_update_auth"
  on public.business_state for update
  to authenticated using (true) with check (true);

-- 4) Realtime: cambios de un equipo se ven en el otro al instante.
do $$
begin
  alter publication supabase_realtime add table public.business_state;
exception when duplicate_object then null;
end $$;

-- 5) Comprobacion final: esto debe devolver una fila con constraint_ok = true.
select
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'business_state'
      and indexname in ('business_state_pkey', 'business_state_business_id_key')
  ) as constraint_ok,
  (select count(*) from public.business_state) as filas;
