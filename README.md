# Albaydar API

API REST de la plataforma de gestión académica del **Centro Educativo Albaydar** (Sevilla · Bachillerato y FP). La consume el front Angular [`app-albaydar-front`](https://github.com/Ceroone-Technology/app-albaydar-front).

Node.js 22 · TypeScript · Express 5 · PostgreSQL 16 · Drizzle ORM · Zod · JWT · Nodemailer · Vitest · Docker.

## Qué hace

| Fase | Contenido | Estado |
|---|---|---|
| **Acceso** | Usuarios con contraseña; cuatro perfiles (Dirección superadministrador, Secretaría, Administración, Comercial) con matriz de permisos ver/editar por módulo, aplicada en caliente | ✅ |
| **01 · Captación** | Formulario web público (con acuse por correo) y alta interna por teléfono, presencial o puertas abiertas | ✅ |
| **02 · Revisión y entrevista** | Bandeja y kanban; 5 comprobaciones automáticas; "pedir que complete"; agenda por jornada (L–V 8:00–18:00); 1 a 3 fechas reservadas hasta que la familia elige; cambio solo en 24 h; boletín de notas; calendario de entrevistas con invitación .ics; recordatorios | ✅ |
| **03 · Evaluación y reserva** | Decisión de admisión con notificación y vista previa (admitida, en espera con posición, no admitida); reserva de plaza de 300 € a 15 días, configurable; cobros manuales (transferencia o efectivo) con recibo R, pagos parciales, anulación y KPIs; recordatorio de pago y aviso de reserva vencida | ✅ |
| **Comunicaciones** | Todos los correos salen de plantillas HTML editables (crear, editar, vista previa, prueba e histórico de envíos) | ✅ |
| **04 · Matrícula digital** | Asistente, firmas, documentos, exportación a Séneca | ⏸️ En pausa |

El detalle de lo que hay y de lo que falta está en [`CLAUDE.md`](CLAUDE.md). El contrato con el front, en [`docs/api.md`](docs/api.md).

## Requisitos

- **Docker Desktop**, arrancado.
- **Node.js 22** para ejecutar los tests o desarrollar sin Docker. Con Node 18 los tests no arrancan. Con nvm-windows:

  ```bash
  nvm install 22.23.3
  nvm use 22.23.3
  ```
- Git.

## Puesta en marcha (Docker, recomendado)

```bash
git clone https://github.com/Ceroone-Technology/albaydar-api.git
cd albaydar-api
docker compose up -d --build
```

Levanta tres contenedores:

| Servicio | Dirección |
|---|---|
| API | http://localhost:3000 · salud: http://localhost:3000/health · rutas bajo `/api` |
| PostgreSQL 16 | `localhost:5432` · base, usuario y contraseña `albaydar` |
| Mailpit (correos de prueba) | http://localhost:8025 |
| Ficheros subidos | carpeta `storage/uploads` del proyecto, en tu equipo |

Al arrancar, la API:
1. espera a PostgreSQL;
2. **aplica las migraciones**;
3. carga los datos base: roles, plantillas de correo, horario de la agenda y configuración de la reserva;
4. carga los datos de demo: usuarios, vías y solicitudes de ejemplo.

Es idempotente: reiniciar no duplica nada.

Los datos viven en un volumen de Docker y sobreviven a `docker compose down`. Para empezar de cero: `docker compose down -v`.

Sin `.env`, todo funciona con valores por defecto y **los correos no salen de tu equipo**: se quedan en Mailpit.

### Usuarios de demo

| Usuario | Perfil | Contraseña |
|---|---|---|
| `admin@albaydar.org` | Dirección (superadministrador) | `CambiaEsto-2026!` |
| `direccion@albaydar.org` | Dirección | `Albaydar-2026` |
| `maria.reyes@albaydar.org`, `juan.diaz@albaydar.org`, `dolores.ruiz@albaydar.org` | Secretaría | `Albaydar-2026` |
| `administracion@albaydar.org` | Administración | `Albaydar-2026` |
| `comercial@albaydar.org` | Comercial / Promoción | `Albaydar-2026` |

Prueba rápida:

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"maria.reyes@albaydar.org","password":"Albaydar-2026"}'
```

### Comandos útiles

```bash
docker compose ps                         # estado de los contenedores
docker compose logs -f api                # ver la API
docker compose up -d --build api          # tras cambiar código
docker compose exec db psql -U albaydar   # consola SQL
docker compose down                       # parar (conserva los datos)
docker compose down -v                    # parar y borrar la base
```

## Configuración (`.env`)

`docker compose` lee el archivo `.env` junto a `docker-compose.yml`. Plantilla: [`.env.docker.example`](.env.docker.example). Todos los valores son opcionales.

```bash
cp .env.docker.example .env
```

**El `.env` nunca se sube a git** (está en `.gitignore`): lleva contraseñas.

### Correos reales con Gmail

1. Crea una **contraseña de aplicación** en https://myaccount.google.com/apppasswords. Requiere la verificación en dos pasos. Son 16 letras.
2. En el `.env`, rellena el bloque de Gmail: `DOCKER_SMTP_HOST=smtp.gmail.com`, `DOCKER_SMTP_PORT=465`, `DOCKER_SMTP_SECURE=true`, `DOCKER_SMTP_USER`, `DOCKER_SMTP_PASS` y `MAIL_FROM`.
3. `docker compose up -d api` y comprueba la conexión con `GET /api/comunicaciones/smtp/estado` (como Dirección).

Detalle en [`docs/gmail.md`](docs/gmail.md).

⚠️ **Con SMTP real, los correos llegan de verdad a la dirección de cada solicitud.**
- Usa solo correos propios. Con alias de Gmail (`tucorreo+prueba1@gmail.com`) tienes muchas "familias" con un solo buzón.
- Las solicitudes de ejemplo de la semilla llevan correos `@correo.es`, un dominio real: no las cites ni les envíes nada.
- Pon `MAIL_SECRETARIA` y `MAIL_ADMINISTRACION` en tu buzón: `@albaydar.org` es el dominio real del centro.
- Si quieres que **todo** vaya a un único buzón, usa `MAIL_DESVIO=tucorreo@gmail.com`.

## Desarrollo sin Docker (con recarga)

```bash
docker compose up -d db mailpit   # o tu propio PostgreSQL 16
npm install
npm run db:migrate
npm run db:seed
npm run dev                       # http://localhost:3000
```

`npm run dev` también lee el `.env`. **Si ya tienes uno para Docker, no lo sobrescribas:** añade al final el contenido de [`.env.example`](.env.example). Las variables de Docker llevan el prefijo `DOCKER_` y no chocan con las de desarrollo. Cambia `JWT_ACCESS_SECRET`.

## Tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # 85 tests
```

Necesitan el contenedor de PostgreSQL levantado: usan la base `albaydar_test`, que se crea sola y se vacía en cada ejecución. El correo de los tests es un transporte falso: nunca envían nada.

- `tests/reglas.test.ts`: funciones puras.
  - las cinco comprobaciones;
  - fechas en hora de Madrid, incluido el cambio de hora;
  - jornada laboral y `.ics`;
  - transiciones del kanban;
  - motor de plantillas;
  - importes, IBAN y plazos.
- `tests/flujo-admision.test.ts`: todo por HTTP contra PostgreSQL real.
  - perfiles y permisos;
  - solicitud y revisión;
  - citación: dos secretarias citando la misma hora a la vez, elegir, cambiar en 24 h, notas y recordatorios;
  - plantillas;
  - contrato con el front;
  - fase 03 completa: decisión, reserva, cobros parciales, anulación, recordatorio, vencimiento, lista de espera, vista previa, recibo y KPIs.

**Antes de subir cualquier cambio: `npm run typecheck` y `npm test` en verde.**

## Base de datos y migraciones

- El esquema está en `src/db/schema.ts`. Las migraciones SQL, en `drizzle/`; `drizzle/meta/` no se edita a mano.
- Para cambiar el esquema:
  1. edita `schema.ts`;
  2. `npm run db:generate -- --name descripcion`;
  3. revisa el SQL generado;
  4. pasa los tests.
- Con Docker, las migraciones se aplican solas al arrancar la API. A mano:

  ```bash
  DATABASE_URL=postgresql://albaydar:albaydar@localhost:5432/albaydar npm run db:migrate
  ```
- Cliente gráfico (DBeaver u otro): PostgreSQL en `localhost:5432`, base `albaydar`, usuario y contraseña `albaydar`. Las fechas se guardan en UTC; las horas del centro son las de Europe/Madrid. Los importes van en céntimos.

## Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| `failed to connect to the docker API … dockerDesktopLinuxEngine` | Docker Desktop no está arrancado |
| `npm test`: `does not provide an export named 'styleText'` o `Cannot find native binding` | Node 18. Cambia a Node 22 (`nvm use 22.23.3`), borra `node_modules` y haz `npm ci` |
| Los tests fallan al conectar con la base | El contenedor `db` no está levantado: `docker compose up -d db` |
| El puerto 5432, 3000 u 8025 está ocupado | Cambia `DB_PORT`, `API_PORT` o `MAILPIT_WEB_PORT` en el `.env` |
| No llegan los correos con Gmail | Revisa `GET /api/comunicaciones/smtp/estado` y el histórico en Comunicaciones. La contraseña debe ser la de aplicación, no la de la cuenta |
| Un correo no sale y la plantilla existe | Está en borrador. Solo se envían las plantillas activadas, salvo las imprescindibles, que llevan el enlace de la familia |

## Estructura

```
src/
  app.ts                   Express, CORS, rutas públicas (/api/auth, /api/public) y privadas
  config/env.ts            variables de entorno validadas + datos fijos del centro
  db/                      schema.ts (fuente de verdad) · migrate.ts · seed.ts (demo) · datos-base.ts
  lib/                     db, fechas (Europe/Madrid), dinero (euros, IBAN), errores, tokens, ficheros
  middleware/              autenticación, permisos, validación Zod, errores
  correo/                  eventos y plantillas predeterminadas, motor de plantillas, .ics, cola de envío
  jobs/                    recordatorios, caducidades, vencimiento de reservas y worker de correo
  modules/
    auth/                  login, refresh con rotación, logout, cambiar contraseña
    usuarios/              alta, edición, baja, restablecer contraseña, responsables
    permisos/              roles, catálogo de permisos y matriz
    ajustes/               horario de la agenda y configuración de la reserva
    agenda/                disponibilidad, ocupación y bloqueos
    solicitudes/           alta, bandeja, kanban, revisión, pedir que complete, estados, avisos
    citacion/              proponer fechas y página pública de la cita
    entrevistas/           calendario y lista
    evaluacion/            decisión de admisión, notificación y vista previa
    reservas/              reserva de plaza, control, recordar, recordatorio y vencimiento
    cobros/                cobros manuales, anulación, resumen y recibo
    comunicaciones/        plantillas de correo, vista previa, prueba e histórico
    documentos/ publico/ catalogo/
drizzle/                   migraciones SQL
docker/                    arranque del contenedor e inicialización de PostgreSQL (crea albaydar_test)
docs/
  api.md                   contrato con el front Angular
  flujo-y-datos.md         estados, reglas, modelo de datos y decisiones técnicas
  preguntas-abiertas.md    decisiones del cliente y lo que falta validar
  gmail.md                 configurar Gmail
tests/                     reglas.test.ts · flujo-admision.test.ts
CLAUDE.md                  contexto completo del proyecto: estado, convenciones, trampas y trabajo pendiente
```

## Producción

- **Imagen:** el `Dockerfile` aplica las migraciones al arrancar. Pon `SEED_DEMO=false` para no cargar datos de demo; con `RUN_SEED=true` se siguen creando los datos base y el usuario de Dirección.
- **Sin Docker:** `npm run build && npm run db:migrate && npm start`.
- **Variables:**
  - `NODE_ENV=production` y `COOKIE_SECURE=true`;
  - `TRUST_PROXY=true` detrás de un proxy;
  - `JWT_ACCESS_SECRET` aleatorio: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
- **Dominio:** servir la API en `/api` del mismo dominio que el front, sin reescribir la ruta (la cookie de refresco va en `path=/api/auth`). Si van en dominios distintos: `COOKIE_SAMESITE=none` (requiere HTTPS) y el dominio del front en `CORS_ORIGINS`.
- **Workers:** el de correo y el de recordatorios corren dentro de la API, y con varias réplicas no se duplican. Para separarlos, `WORKERS_ENABLED=false` en las réplicas web.
- **Pendiente antes de producción** (ver [`CLAUDE.md`](CLAUDE.md)):
  - remitente de correo propio del centro;
  - almacenamiento de ficheros en la nube (UE);
  - plazo de conservación de datos (RGPD);
  - IBAN real y datos fiscales para el recibo.
