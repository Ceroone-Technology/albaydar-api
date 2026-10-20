# Albaydar API

API de la plataforma de gestión académica del Centro Educativo Albaydar. Esta primera fase cubre:

- **Acceso:** usuarios con contraseña, cuatro perfiles (Dirección superadministrador, Administración, Secretaría, Comercial) y matriz de permisos ver/editar por módulo.
- **Admisión:** solicitud web → revisión (5 comprobaciones) → pedir que complete → citación.
- **Citación:** agenda por jornada laboral (L–V 8:00–18:00); 1 a 3 fechas que quedan reservadas hasta que la familia elige; cambio solo en las 24 h siguientes; entrevista en el calendario con invitación .ics.
- **Comunicaciones:** todos los correos salen de plantillas HTML editables (crear, editar, eliminar, vista previa, prueba e histórico), incluidos los dos recordatorios.

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
| Ficheros subidos | carpeta `storage/uploads` del proyecto (en tu equipo) |

Al arrancar, la API espera a PostgreSQL, aplica las migraciones y carga roles, plantillas de correo, horario de la agenda, usuarios, vías y solicitudes de ejemplo. Es idempotente: reiniciar no duplica nada. Los datos de la base viven en un volumen de Docker y sobreviven a `docker compose down`; para empezar de cero: `docker compose down -v`.

| Usuario | Perfil | Contraseña |
|---|---|---|
| `admin@albaydar.org` | Dirección (superadministrador) | `CambiaEsto-2026!` |
| `direccion@albaydar.org` | Dirección | `Albaydar-2026` |
| `maria.reyes@albaydar.org`, `juan.diaz@albaydar.org`, `dolores.ruiz@albaydar.org` | Secretaría | `Albaydar-2026` |
| `administracion@albaydar.org` | Administración | `Albaydar-2026` |
| `comercial@albaydar.org` | Comercial / Promoción | `Albaydar-2026` |

**Correos reales con Gmail:** copia `.env.docker.example` como `.env`, rellena el bloque de Gmail y sigue `docs/gmail.md`.

Comandos útiles:

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

- `tests/reglas.test.ts`: las cinco comprobaciones, fechas en hora de Madrid (incluido el cambio de hora), jornada laboral, .ics, kanban y el motor de plantillas (escapado, saneado, variables).
- `tests/flujo-admision.test.ts`: todo por HTTP contra PostgreSQL real: perfiles y permisos (incluido el cambio en caliente), usuarios, solicitud, reserva de fechas, dos secretarias citando la misma hora a la vez, elegir, cambiar en 24 h y bloqueo después, notas, recordatorios, "ninguna me encaja" y el CRUD de plantillas.

## Estructura

```
src/
  config/env.ts            variables de entorno validadas + datos fijos del centro
  db/schema.ts             esquema (fuente de verdad) · migrate.ts · seed.ts · datos-base.ts
  lib/                     db, fechas (Europe/Madrid), errores, tokens, almacenamiento de ficheros
  middleware/              autenticación, permisos, validación Zod, errores
  correo/                  eventos y plantillas predeterminadas, motor de plantillas, .ics, cola de envío
  jobs/                    recordatorios, caducidad de propuestas y worker de correo
  modules/
    auth/                  login, refresh con rotación, logout, cambiar contraseña
    usuarios/              alta, edición, baja, restablecer contraseña
    permisos/              roles, catálogo de permisos y matriz
    ajustes/               horario de la agenda
    agenda/                disponibilidad, ocupación y bloqueos
    solicitudes/           alta, bandeja, kanban, revisión, pedir que complete, estados
    citacion/              proponer fechas y página pública de cita
    entrevistas/           calendario y lista
    comunicaciones/        plantillas de correo, vista previa, prueba e histórico
    documentos/ publico/ catalogo/
drizzle/                   migraciones SQL
docker/                    arranque del contenedor e inicialización de PostgreSQL
docs/
  api.md                   contrato para el front Angular
  flujo-y-datos.md         estados, reglas, modelo de datos y decisiones
  gmail.md                 configurar Gmail para la demo
  preguntas-abiertas.md    decisiones tomadas y lo que falta validar
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
- En producción `db:seed` solo crea los datos base (roles, plantillas, horario) y el usuario de Dirección.
