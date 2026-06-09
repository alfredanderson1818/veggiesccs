# Conectar Supabase (login real + datos en la nube + pedidos web al sistema)

## Qué vamos a lograr
- **Login real** para administradores (correo + contraseña).
- **Datos en la nube:** productos, clientes, pedidos, créditos, caja, inventario, tasa...
  compartidos entre dispositivos y respaldados.
- **Pedidos de la web entran al sistema:** cuando un cliente pide en veggiesccs.com/pedidos,
  aparece en una bandeja "Pedidos web" en el admin, en vivo.

## PASO 1 — Crear la cuenta y el proyecto (lo haces tú, ~3 min)
1. Entra a https://supabase.com → **Start your project** → inicia sesión (con GitHub o correo).
2. **New project** → ponle nombre `veggies-ccs`, una contraseña de base de datos (guárdala),
   región la más cercana (ej. East US) → **Create new project**. Espera ~1 min a que se cree.

## PASO 2 — Copiar las 2 claves
3. En el proyecto: ícono ⚙️ **Project Settings** → **API** (o "Data API").
4. Copia:
   - **Project URL**  (algo como `https://abcd1234.supabase.co`)
   - **anon public** key  (una clave larga que empieza con `eyJ...`)
5. Pégalas en `src/supabase/config.mjs` (o pásamelas en el chat).

## PASO 3 — Crear las tablas (copiar/pegar SQL)
6. Menú izquierdo → **SQL Editor** → **New query** → pega TODO esto y dale **Run**:

```sql
-- Estado del negocio (clave/valor): productos, clientes, pedidos, etc.
create table if not exists business_state (
  business_id text not null,
  key text not null,
  value jsonb,
  updated_at timestamptz default now(),
  primary key (business_id, key)
);
alter table business_state enable row level security;
create policy "estado_select" on business_state for select using (auth.role() = 'authenticated');
create policy "estado_insert" on business_state for insert with check (auth.role() = 'authenticated');
create policy "estado_update" on business_state for update using (auth.role() = 'authenticated');
create policy "estado_delete" on business_state for delete using (auth.role() = 'authenticated');

-- Pedidos hechos desde la web publica (los clientes no tienen login).
create table if not exists web_orders (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'veggies-ccs',
  created_at timestamptz default now(),
  status text not null default 'nuevo',
  customer_name text,
  customer_phone text,
  address text,
  items jsonb not null,
  subtotal numeric,
  delivery numeric,
  total numeric,
  note text
);
alter table web_orders enable row level security;
create policy "pedido_web_crear" on web_orders for insert with check (true);
create policy "pedido_web_ver"    on web_orders for select using (auth.role() = 'authenticated');
create policy "pedido_web_editar" on web_orders for update using (auth.role() = 'authenticated');
```

## PASO 4 — Crear tu usuario admin
7. Menú **Authentication** → **Users** → **Add user** → tu correo (ej. `adam@veggiesccs.com`) + contraseña.
   Ese será tu login en veggiesccs.com/admin.
8. (En **Authentication → Providers** asegúrate de que **Email** esté habilitado — viene activo por defecto.)

## PASO 5 — Dármelo
9. Pégame en el chat la **Project URL** y la **anon key** (o ponlas en `src/supabase/config.mjs`).
   Con eso yo conecto:
   - Login `/admin` con Supabase Auth.
   - Guardado en la nube (localStorage → Supabase) con respaldo y sync.
   - La página de pedidos guarda el pedido en `web_orders`.
   - Módulo "Pedidos web" en el admin que los muestra en vivo y los carga al sistema.

> La **anon key** es pública (va en el navegador). La seguridad la dan las **políticas RLS**
> (solo logueados ven/editan; los clientes solo pueden crear pedidos).
