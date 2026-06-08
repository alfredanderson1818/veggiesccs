# Conectar Firebase (login real + datos en la nube)

## Qué vamos a lograr
- **Login real** para administradores (correo y contraseña), no el candado temporal.
- **Datos en la nube (Firestore):** productos, clientes, pedidos, créditos, caja, inventario, tasa...
  se guardan en línea, se comparten entre dispositivos y quedan respaldados.
- **Seguridad:** solo usuarios autenticados pueden ver/editar los datos del negocio.

## PASO 1 — Crear el proyecto (lo haces tú, ~3 min)
1. Entra a https://console.firebase.google.com  → **Agregar proyecto** → nómbralo `veggies-ccs` → crear.
2. Dentro del proyecto, icono **</>** ("Agregar app web") → ponle nombre `veggies-web` → **Registrar app**.
3. Firebase te muestra un bloque `const firebaseConfig = { apiKey: "...", ... }`. **Copia ese bloque.**

## PASO 2 — Activar Firestore y Auth
4. Menú izquierdo → **Build → Firestore Database** → **Crear base de datos** → modo **Producción** → ubicación `nam5` (o la más cercana) → habilitar.
5. Menú izquierdo → **Build → Authentication** → **Comenzar** → pestaña **Sign-in method** → habilita **Correo electrónico/contraseña**.
6. En **Authentication → Users → Agregar usuario**: crea tu usuario admin (ej. `adam@veggiesccs.com` + una contraseña). Ese será tu login.

## PASO 3 — Dármelo
7. Pégame aquí en el chat el bloque `firebaseConfig` (o pégalo en `src/firebase/config.mjs`).
   Con eso yo:
   - Conecto el login `/admin` a Firebase Auth (tu correo + contraseña reales).
   - Migro el guardado de localStorage → Firestore (datos compartidos + respaldo).
   - Pongo las reglas de seguridad (solo logueados acceden).
   - Dejo botón de "Cerrar sesión" real.

## Notas
- El `apiKey` de Firebase **no es secreto** (va en el front); la seguridad la dan las **reglas** + el login.
- La web pública de pedidos seguirá usando el catálogo del sitio; cuando edites precios en el admin
  los sincronizamos al catálogo público en un segundo paso.
