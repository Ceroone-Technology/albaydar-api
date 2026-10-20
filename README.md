# Albaydar API

API de la plataforma de gestión académica del Centro Educativo Albaydar. Esta primera fase cubre **autenticación** y la primera parte del flujo de admisión:

> solicitud web → revisión (5 comprobaciones) → pedir que complete → citación (1 a 3 huecos) → la familia elige fecha → entrevista en el calendario, con correos, invitación .ics y recordatorios.

Node.js 20+ · TypeScript · Express 5 · PostgreSQL 16 · Drizzle ORM · Zod · JWT · Nodemailer.

## Arrancar con Docker (recomendado)

Solo necesitas Docker Desktop. Levanta PostgreSQL, la API y Mailpit:

```bash
docker compose up -d --build
```

| Servicio | Dirección |
|---|---|
| API | http://localhost:3000 (salud: `/health`) |
| PostgreSQL | `localhost:5432`, usuario y contraseña `albaydar` |
| Correos (Mailpit) | http://localhost:8025 |

Al arrancar, la API espera a PostgreSQL, aplica las migraciones y siembra usuarios, vías y solicitudes de ejemplo (es idempotente: reiniciar no duplica nada). Los datos viven en volúmenes de Docker y sobreviven a `docker compose down`; para empezar de cero: `docker compose down -v`.

Usuarios de demo (contraseña `Albaydar-2026`): `maria.reyes@albaydar.org`, `juan.diaz@albaydar.org`, `dolores.ruiz@albaydar.org` (Secretaría), `direccion@albaydar.org` (Dirección), `administracion@albaydar.org`. Administrador: `admin@albaydar.org` / `CambiaEsto-2026!`.

Para cambiar puertos, contraseñas o el SMTP, copia `.env.docker.example` como `.env`. Comandos útiles:

```bash
docker compose logs -f api                                  # ver la API
docker compose exec db psql -U albaydar                     # consola SQL
docker compose up -d --build api                            # tras cambiar código
```

## Arrancar sin Docker (desarrollo con recarga)

```bash
docker compose up -d db mailpit # o tu propio PostgreSQL
cp .env.example .env            # y cambia JWT_ACCESS_SECRET
npm install
npm run db:migrate
npm run db:seed
npm run dev                     # http://localhost:3000
```

## Tests

```bash
npm test                        # usa la BD albaydar_test que crea el contenedor de PostgreSQL
```

- `tests/reglas.test.ts`: las cinco comprobaciones, fechas en hora de Madrid (incluido el cambio de hora), .ics, kanban.
- `tests/flujo-admision.test.ts`: el flujo entero por HTTP contra PostgreSQL real, con login y rotación de sesión, enlaces de un solo uso, dos familias eligiendo el mismo hueco a la vez, cambio de fecha, subida de notas, "ninguna me encaja" y los dos recordatorios.

## Estructura

```
src/
  config/env.ts            variables de entorno validadas + datos fijos del centro
  db/schema.ts             esquema (fuente de verdad) · migrate.ts · seed.ts
  lib/                     db, fechas (Europe/Madrid), errores, tokens, almacenamiento
  middleware/              auth (JWT + roles), validación Zod, errores
  correo/                  plantillas, .ics, cola de envío (outbox)
  jobs/                    recordatorios y worker de correo
  modules/
    auth/                  login, refresh con rotación, logout, cambiar contraseña
    solicitudes/           alta, bandeja, kanban, revisión, pedir que complete, estados
    citacion/              proponer huecos y página pública de cita
    agenda/                huecos del equipo directivo
    entrevistas/           calendario y lista
    documentos/            boletín de notas
    publico/               rutas sin login
    usuarios/ catalogo/
drizzle/0000_inicial.sql   migración SQL del esquema
docs/
  api.md                   contrato para el front Angular
  flujo-y-datos.md         estados, reglas, modelo de datos y decisiones
  preguntas-abiertas.md    lo que hay que validar con el cliente
```

## Cambiar el esquema

1. Edita `src/db/schema.ts`.
2. `npm run db:generate -- --name descripcion` genera el SQL en `drizzle/`.
3. Revisa el SQL, súbelo a git y aplícalo con `npm run db:migrate`.

## Producción

- La imagen (`Dockerfile`) aplica las migraciones al arrancar. Pon `RUN_SEED=false` o `SEED_DEMO=false` para no cargar datos de demo.
- Sin Docker: `npm run build && npm run db:migrate && npm start`.
- `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true` detrás de un proxy, y un `JWT_ACCESS_SECRET` aleatorio.
- Si front y API están en dominios distintos: `COOKIE_SAMESITE=none` (requiere HTTPS) y añade el dominio del front a `CORS_ORIGINS`.
- Los workers (correo y recordatorios) corren dentro de la API. Con varias réplicas no se duplican. Para separarlos, pon `WORKERS_ENABLED=false` en las réplicas web.
- En producción `db:seed` solo crea el administrador.
