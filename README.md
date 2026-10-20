# Albaydar API

API de la plataforma de gestión académica del Centro Educativo Albaydar. Esta primera fase cubre **autenticación** y la primera parte del flujo de admisión:

> solicitud web → revisión (5 comprobaciones) → pedir que complete → citación (1 a 3 huecos) → la familia elige fecha → entrevista en el calendario, con correos, invitación .ics y recordatorios.

Node.js 20+ · TypeScript · Express 5 · PostgreSQL 16 · Drizzle ORM · Zod · JWT · Nodemailer.

## Arrancar en local

```bash
cp .env.example .env            # y cambia JWT_ACCESS_SECRET
docker compose up -d            # PostgreSQL + Mailpit
npm install
npm run db:migrate              # crea las tablas
npm run db:seed                 # usuarios, vías y solicitudes de ejemplo
npm run dev                     # http://localhost:3000
```

Los correos que envía la API se ven en **http://localhost:8025** (Mailpit).

Usuarios de demo (contraseña `Albaydar-2026`): `maria.reyes@albaydar.org`, `juan.diaz@albaydar.org`, `dolores.ruiz@albaydar.org` (Secretaría), `direccion@albaydar.org` (Dirección), `administracion@albaydar.org`. Administrador: el de `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.

## Tests

```bash
createdb albaydar_test          # una vez (o TEST_DATABASE_URL=…)
npm test
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

- `npm run build && npm run db:migrate && npm start`.
- `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true` detrás de un proxy, y un `JWT_ACCESS_SECRET` aleatorio.
- Si front y API están en dominios distintos: `COOKIE_SAMESITE=none` (requiere HTTPS) y añade el dominio del front a `CORS_ORIGINS`.
- Los workers (correo y recordatorios) corren dentro de la API. Con varias réplicas no se duplican. Para separarlos, pon `WORKERS_ENABLED=false` en las réplicas web.
- En producción `db:seed` solo crea el administrador.
