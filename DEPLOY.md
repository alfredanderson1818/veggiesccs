# Publicar Veggies CCS en www.veggiesccs.com

La app es estatica (HTML + JS + CSS, sin build). Se publica tal cual en GitHub Pages.
La base de datos real (Firebase) es un paso aparte (ver al final).

## 1. Subir el codigo a GitHub  (lo haces tu, una vez)

En esta carpeta (`VeggiesCcs/`) ya esta el repositorio git inicializado con el primer commit.
Solo falta crear el repo en GitHub y enviarlo:

1. Entra a https://github.com/new y crea un repositorio (ej. `veggies-ccs`), **vacio** (sin README).
2. Copia los comandos que te da GitHub para "push an existing repository", o usa estos
   (reemplaza `TU-USUARIO`):

   ```bash
   cd "/Users/adammanir/Documents/VeggiesCcs"
   git remote add origin https://github.com/TU-USUARIO/veggies-ccs.git
   git branch -M main
   git push -u origin main
   ```

## 2. Activar GitHub Pages

1. En el repo: **Settings → Pages**.
2. En "Build and deployment" → Source: **Deploy from a branch**.
3. Branch: **main**, carpeta **/(root)** → Save.
4. En "Custom domain" escribe: `www.veggiesccs.com` → Save. (Ya hay un archivo `CNAME`
   con ese valor, asi que quiza aparezca solo.)
5. Marca **Enforce HTTPS** cuando se habilite.

## 3. Apuntar el dominio (DNS en tu registrador)

En el panel DNS de veggiesccs.com agrega:

- Registro **CNAME**: nombre `www` → valor `TU-USUARIO.github.io`
- (Opcional, para que `veggiesccs.com` sin www tambien funcione) registros **A** del apex `@`:
  - 185.199.108.153
  - 185.199.109.153
  - 185.199.110.153
  - 185.199.111.153

El DNS puede tardar de minutos a unas horas. Luego la app queda en https://www.veggiesccs.com

> Importante: asi publicada, los datos siguen guardandose en el navegador de cada equipo
> (localStorage). Para compartir datos entre dispositivos/cajeros y tener respaldo, falta
> conectar Firebase (paso 4).

## 4. Backend con Firebase  (siguiente fase)

1. Entra a https://console.firebase.google.com y crea un proyecto (ej. `veggies-ccs`).
2. Agrega una **app web** (icono `</>`). Firebase te dara un objeto `firebaseConfig`
   con `apiKey`, `authDomain`, `projectId`, etc.
3. Activa **Firestore Database** (modo produccion) y **Authentication** (Email/Password).
4. Pasame ese `firebaseConfig` y yo conecto la app: migro el guardado de localStorage a
   Firestore, agrego login y reglas de seguridad. (Es un refactor mediano pero directo.)
