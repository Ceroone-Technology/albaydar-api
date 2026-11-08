# Albaydar API · contexto para Claude Code

API de la plataforma de gestión académica del **Centro Educativo Albaydar** (Sevilla; Bachillerato y FP). La consume un front en **Angular 19** (repo `Ceroone-Technology/app-albaydar-front`). Los mockups HTML validados con el cliente son la especificación funcional. Responde y documenta **en español**.

Este archivo es el punto de partida para cualquier sesión: qué hay, cómo se trabaja, qué falta y qué trampas ya conocemos. Antes de tocar algo, lee también `docs/api.md` (contrato con el front), `docs/flujo-y-datos.md` (estados, reglas, modelo) y `docs/preguntas-abiertas.md` (decisiones del cliente y lo pendiente).

## Estado en una mirada

| Fase (diagrama de flujo del cliente) | Estado |
|---|---|
| 01 · Captación (formulario web, alta interna) | ✅ Hecha |
| 02 · Revisión y entrevista (bandeja, kanban, citación, agenda, entrevistas) | ✅ Hecha |
| 03 · Evaluación y reserva de plaza (decisión, reserva, cobros manuales) | ✅ Hecha |
| 04 · Matrícula digital (asistente, firmas, documentos, Séneca) | 🟡 **En curso.** Entrega 1 de 4 hecha el 08/11/2026 (API `feat/matricula-borrador`): apertura, renovación, borrador con versión, páginas leídas y enlaces. Plan en `docs/matricula.md` → «Entregas» |
| Alumnado (expedientes, familias, historial) | ✅ Hecho el 08/11/2026 (API `feat/alumnado`, front `feature/alumnado-api`) |
| Cobros completos (remesas SEPA, conciliación, facturación) | ❌ Sin empezar |

En el front, a 24/10/2026 (`develop` = `main`, PR #12): conectados la sesión, los permisos, el formulario público, la bandeja, la citación, la página `/cita/:token` y el kanban. Evaluación y reserva, conectada (PR #13: decisión con vista previa, control de reservas y «Recordar»); el kanban ya no decide sin notificar, abre esa pantalla. Cobros, conectada (PR #14: KPI, reservas por vencer, registro manual, recibo y anulación); el kanban abre Cobros para «Plaza reservada». Entrevistas, conectada en la rama `feature/entrevistas-api` (calendario, resultado, no presentada, cancelación y nota; sin «Confirmar cita», que es de la familia). Configuración y Comunicaciones son placeholders por construir contra esta API. Matrícula y Alumnado siguen con su API simulada.

## Stack y comandos

Node.js **22** (con Node 18 vitest no arranca) · TypeScript (strict) · **Express 5** · PostgreSQL 16 · **Drizzle ORM** · Zod 4 · JWT · Nodemailer · Vitest.
La API es Express a propósito: decisión del equipo, aunque en una reunión con el cliente se mencionó NestJS. No migrar sin preguntar.

```bash
docker compose up -d --build     # API :3000 + PostgreSQL :5432 + Mailpit :8025 (migra y siembra al arrancar)
DB_PORT=5433 docker compose up -d --build  # en el Mac: Subvfy ocupa el 5432. Entonces, para tests:
TEST_DATABASE_URL=postgresql://albaydar:albaydar@localhost:5433/albaydar_test npm test
docker compose up -d --build api # tras cambiar código
docker compose down -v           # empezar de cero (borra la BD; necesario si cambia la migración 0000)
npm run dev                      # sin Docker, con recarga (necesita db y mailpit levantados)
npm run typecheck                # tsc --noEmit
npm test                         # usa la BD albaydar_test (la crea el contenedor de PostgreSQL)
npm run db:generate -- --name x  # tras editar src/db/schema.ts → SQL nuevo en drizzle/
DATABASE_URL=postgresql://albaydar:albaydar@localhost:5432/albaydar npm run db:migrate
```

**Antes de dar algo por terminado: `npm run typecheck` y `npm test` en verde.** Si cambia el contrato, actualiza `docs/api.md` en el mismo cambio.

## Entorno local

- **Docker Desktop** tiene que estar arrancado. PostgreSQL: `localhost:5432`, usuario, contraseña y base `albaydar`. La base de tests es `albaydar_test`: se borra y se recrea en cada `npm test`, así que no la uses para mirar datos.
- **Usuarios de demo** (contraseña `Albaydar-2026`):
  - Dirección: `direccion@albaydar.org`;
  - Secretaría: `maria.reyes@`, `juan.diaz@` y `dolores.ruiz@albaydar.org`;
  - Administración: `administracion@albaydar.org`;
  - Comercial: `comercial@albaydar.org`.

  Superadministrador: `admin@albaydar.org` / `CambiaEsto-2026!`.
- **Configuración de Docker:** `.env` junto a `docker-compose.yml` (plantilla: `.env.docker.example`). **Nunca se sube a git.** Las variables SMTP de Docker llevan el prefijo `DOCKER_`.
- **Correo real.** En el equipo del desarrollador, el `.env` apunta a Gmail con contraseña de aplicación, sin `MAIL_DESVIO`: los correos llegan de verdad a la dirección de cada solicitud. `MAIL_SECRETARIA` y `MAIL_ADMINISTRACION` apuntan al buzón del desarrollador, no a `@albaydar.org`, que es un dominio real del centro. Sin `.env`, todo va a Mailpit (http://localhost:8025).
  - Las solicitudes de ejemplo de la semilla usan `@example.com` (dominio reservado, nunca entrega). Hasta el 05/11/2026 usaban `@correo.es`, un dominio real: la semilla corrige esas filas en una BD de demo ya creada. Las de prueba, con `@example.com` o alias propios.
  - Para probar, usa alias propios (`buzon+prueba1@gmail.com`).
- **Ficheros subidos:** carpeta `storage/uploads` del equipo (ignorada por git; puede contener boletines reales de prueba).

## Estructura

```
src/
  app.ts                 Express: helmet, CORS con credenciales, rutas públicas (/auth, /public) y privadas (requireAuth por prefijo → una ruta inexistente da 404, nunca 401)
  config/env.ts          variables validadas con Zod + CENTRO (nombre, dirección, teléfono, logo, datos de la entrevista)
  db/schema.ts           esquema (fuente de verdad) · migrate.ts · seed.ts (demo) · datos-base.ts (roles, plantillas, ajustes; también en producción)
  lib/                   db, fechas (única conversión UTC ↔ Europe/Madrid), dinero (euros, IBAN), documento-identidad (DNI/NIE), errores, crypto, storage, logger
  middleware/            auth (requireAuth, requirePermiso), validate (Zod), error-handler
  correo/                eventos.ts (catálogo), plantillas.ts (motor), enviar.ts (prepararEvento / enviarEvento), outbox.ts (cola + SMTP), ics.ts
  jobs/                  scheduler.ts (node-cron + advisory locks) y recordatorios.ts
  modules/
    auth/                login, refresh con rotación (cookie alb_rt), logout, cambiar contraseña
    usuarios/            alta, edición, baja, restablecer contraseña, responsables
    permisos/            catálogo de módulos y permisos, roles, matriz ver/editar
    ajustes/             ajustes.agenda (jornada) y ajustes.reserva (importe, IBAN, plazo, formas de pago)
    agenda/              disponibilidad, ocupación, bloqueos, configuración
    solicitudes/         dominio.ts (estados, columnas, transiciones, etiquetas), comun.ts (cambiarEstado, revisiones por lotes, contadores), revision.ts (5 comprobaciones), service (listas, kanban, ficha, avisos), routes
    citacion/            proponer fechas, página pública de la cita, elegir, otra franja, .ics
    entrevistas/         calendario y lista, resultado, cancelar
    evaluacion/          decisión de admisión con notificación y su vista previa
    reservas/            reserva de plaza, control de reservas, recordar, recordatorio y vencimiento
    cobros/              cobros manuales, anulación, resumen (KPIs) y recibo imprimible
    alumnado/            expedientes (alta desde la reserva pagada, manual), contactos, historial, baja, notas
    matricula/           borrador.ts (Zod del EnrollmentDraft del front), reglas.ts (copia de enrollment.rules.ts), dominio.ts, service (apertura, renovación, borrador con versión, páginas, enlaces), routes (privadas y /public/matricula)
    comunicaciones/      plantillas (CRUD, vista previa, prueba), histórico de envíos, estado SMTP
    documentos/ publico/ catalogo/
drizzle/                 migraciones SQL (0000–0009) y meta/ (journal + snapshots: no se editan a mano)
docs/                    api.md · flujo-y-datos.md · preguntas-abiertas.md · gmail.md · matricula.md (diseño de la fase 04)
tests/                   reglas.test.ts (funciones puras) · flujo-admision.test.ts y matricula.test.ts (HTTP contra PostgreSQL real, SMTP falso)
```

## Qué está implementado

**Acceso y permisos**
- JWT de 15 min (en memoria del front) y refresh en cookie httpOnly `alb_rt` (`path=/api/auth`), con rotación y revocación si se reutiliza. Bloqueo de 15 min tras 5 fallos.
- Cuatro roles (Dirección, que es superadmin; Secretaría; Administración; Comercial) y matriz ver/editar por módulo, editable por Dirección y aplicada en caliente (caché de 10 s).
- `GET /usuarios/responsables` devuelve solo a quien tiene `solicitudes.editar`.

**Solicitudes y admisión**
- Formulario público con honeypot `website` y `asignadaSnec` opcional; acuse por correo. Alta interna con canal.
- Las cinco comprobaciones se recalculan en cada lectura y por lotes (3 consultas por página).
- "Pedir que complete" con enlace de un solo uso.
- Cada solicitud de lista, bandeja y kanban trae: `revision`, `propuesta` vigente, `entrevista` (con `notas`), `notasSubidas`, `reserva`, `posicionEspera` y `siguientes`.
- Kanban:
  - filtros `notasPendientes`, `familiaVinculada` y `reservaPorVencer`;
  - la respuesta trae `total` y `coinciden`;
  - el embudo cuenta también lo que está en la bandeja (decisión D1 con el front).
- `siguientes`: los destinos permitidos para **este** usuario. Si llevan `accion` (`PEDIR_QUE_COMPLETE`, `CITAR_A_ENTREVISTA`, `DECIDIR`, `REGISTRAR_COBRO`), el front abre ese panel en vez de hacer `PATCH /estado`.
- Aviso "la familia ya eligió fecha": `GET /solicitudes/respuestas-familia` y `POST …/visto`, con el "visto" guardado por usuario (tabla `eventos_vistos`).

**Citación, agenda y entrevistas**
- La agenda es la jornada (L–V 8–18, configurable) menos lo ocupado. Entrevistas de 45 o 60 min, siempre presenciales con el equipo directivo.
- Secretaría propone 1–3 fechas, que quedan `RESERVADA`. La restricción `EXCLUDE` de la BD impide dobles reservas.
- La familia elige desde `/cita/:token`. `elegir` y `otra-franja` devuelven la cita completa.
- La familia puede cambiar durante 24 h desde la primera aceptación. Tiene "Ninguna me encaja" y subida del boletín de notas (se valida el tipo real del fichero).
- Recordatorios a los 3 días sin elegir y el día antes de la entrevista. Las propuestas caducan solas.
- Calendario con `items` (confirmadas, con `notas`) y `pendientes`. Resultado de la entrevista y cancelación con `.ics`.
- **Ficha de la entrevista** (`entrevistas/ficha.ts`, 05/11/2026): la de la solicitud en papel (otro centro, por qué Albaydar, repetición, nota media, modalidad y optativa de Bachillerato, boletín entregado, valoración Favorable / Con reservas / Desfavorable con comentario, entrevistados y quién entrevistó; observaciones = `notas`). JSON en `entrevistas.ficha`, parcial en `PATCH /entrevistas/:id`. Dar por realizada exige valoración y entrevistados (`FICHA_INCOMPLETA`).

**Fase 03: evaluación, reserva y cobros** (detalle en `docs/api.md`)
- `POST /solicitudes/:id/decision` (`evaluacion.editar`):
  - **Admitida:** crea la reserva y notifica con importe, IBAN y fecha límite.
  - **En espera:** posición automática por vía.
  - **No admitida:** motivo.

  Arrastrar a una decisión responde 409 `ACCION_REQUERIDA` con `accion: "DECIDIR"`.
- `POST /solicitudes/:id/decision/previsualizar`: el correo que recibiría la familia, con sus datos reales, sin cambiar nada.
- **Plazo de la reserva por solicitud** (05/11/2026): al admitir, `fechaLimite` opcional para acortarlo (de mañana al plazo general); después, `PATCH /reservas/:id/plazo` para acortarlo o ampliarlo (hasta 90 días; una vencida vuelve a pendiente), con motivo en el historial y aviso opcional a la familia.
- **Reserva:** 300 € por defecto, con excepciones por vía; 15 días naturales; transferencia o efectivo. IBAN provisional y ficticio, validado. Todo en `ajustes.reserva`, vía `GET/PUT /reservas/configuracion`.
- **Control de reservas:** `GET /reservas?porVencer=true`, con días restantes. "Recordar" (`POST /reservas/:id/recordar`), con un mínimo de 1 h entre envíos.
- **Recordatorio automático** a 3 días del plazo, uno solo, que no sale si ya se usó "Recordar". Vencida: aviso a secretaría y administración; la plaza no se libera sola y el pago tardío se acepta.
- **Cobros manuales** (`POST /cobros`):
  - recibo `R-AAAA-NNNN` correlativo por año; pagos parciales; nunca más de lo pendiente;
  - al cubrir la reserva, en la misma transacción, la reserva queda `PAGADA` y la solicitud pasa a `PLAZA_RESERVADA`;
  - un cobro no se borra: se anula con motivo, y si la reserva queda sin cubrir, la solicitud vuelve a `ADMITIDA`.
- `GET /cobros` (pestaña Pagos), `GET /cobros/resumen` (KPIs: cobrado, pendiente, parcial) y `GET /cobros/:id/recibo` (HTML imprimible, con mención de exención de IVA, art. 20.Uno.9.º LIVA).
- La migración `0004` creó la reserva de las solicitudes admitidas antes de la fase 03, sin enviar correo.

**Exportaciones** (05/11/2026)
- `GET /solicitudes|entrevistas|reservas|cobros|alumnado/exportar`: CSV para Excel con los mismos filtros y permisos que su listado, sin paginar (`todasLasPaginas` en `lib/csv.ts`; columnas en `modules/exportaciones/columnas.ts`). Separador `;`, BOM, coma decimal, protección contra inyección de fórmulas y registro en el log de cada exportación.

**Alumnado** (08/11/2026, detalle en `docs/api.md`)
- Expediente `EXP-AAAA-NNNN` (formato del mockup) con estados del mockup: «Reserva confirmada» (`RESERVA`), «En proceso» (`EN_PROCESO`), «Matriculada» (`MATRICULADA`) y «Baja».
- Nace solo cuando el cobro completa la reserva (`altaDesdeReserva`, en su transacción), con el tutor como contacto principal. Si se anula ese cobro, `retirarAltaDeReserva` lo borra (sin cambios) o lo da de baja (con notas o cambios); al volver a pagar, se reactiva el mismo.
- Alta manual con DNI/NIE validado y único, edición (los contactos se sustituyen enteros), baja con motivo y reactivación por `PATCH { estado }`, notas internas y CSV.
- Historial: eventos propios (`alumna_eventos`, solo qué campos cambian, nunca los valores) más la solicitud, sus correos, entrevistas y cobros.
- «Familia ya vinculada» (revisión y filtro del kanban) mira también los contactos de las alumnas que no están de baja.
- Mientras no exista la matrícula digital, secretaría mueve los estados a mano.

**Matrícula digital, entrega 1** (08/11/2026, detalle en `docs/api.md` y `docs/matricula.md`)
- `POST /matriculas { alumnaId }`: alumnado nuevo (expediente en reserva o en proceso → «En proceso») o renovación 1º → 2º (expediente matriculado en 1º, a partir de su matrícula de 1º). `POST /matriculas/renovacion` la abre en bloque para quien promociona. Código `M-AAAA-NNNN`, una por alumna y curso escolar.
- El borrador es el `EnrollmentDraft` del front tal cual (nombres en inglés) y las reglas son una copia de `enrollment.rules.ts`: la ficha trae `pendientes` por paso y `puedeEnviar`.
- `PUT { borrador, version }` desde secretaría o desde el enlace: 409 `VERSION_ANTIGUA` con quién guardó; sin cambios no sube la versión. La familia no cambia la vía, el curso, «alumna nueva» ni `manualChecks`.
- Páginas leídas con hora del servidor, que nunca se quitan; `POST …/paginas-leidas` no sube la versión.
- Enlaces `FAMILIA` y `PROGENITOR` (solo lectura y, más adelante, sus firmas), caducan el 30/09 del curso; límites por enlace en `/public/matricula/:token`.
- Falta: firmas con huella, mandatos SEPA, archivos, envío, PDF y Séneca (entregas 2 y 3), y el front (entrega 4).

**Comunicaciones**
- Todos los correos salen de plantillas HTML editables, una activada por evento. Saneado al guardar y variables validadas. Vista previa, prueba e histórico.
- Eventos:
  - `SOLICITUD_RECIBIDA`, `COMPLETAR_SOLICITUD`*, `CITACION_PROPUESTA`*, `CITACION_RECORDATORIO`, `CITA_CONFIRMADA`*, `CITA_CAMBIADA`*, `ENTREVISTA_RECORDATORIO`, `CITA_CANCELADA`, `AVISO_OTRA_FRANJA`;
  - de la fase 03: `ADMITIDA`, `EN_ESPERA`, `NO_ADMITIDA`, `RECORDATORIO_PAGO`, `RESERVA_VENCIDA`;
  - de la fase 04: `MATRICULA_ENLACE`* y `MATRICULA_ENLACE_PROGENITOR`*;
  - en borrador: `MATRICULA_CONFIRMADA`.

  (*) Obligatorios: llevan el enlace de la familia y se envían aunque la plantilla esté en borrador.
- Correo con outbox: se guarda en la misma transacción y un worker lo envía cada 15 s, con reintentos.

## Modelo de datos y migraciones

Tablas:
- `usuarios`, `refresh_tokens`, `roles`, `ajustes`, `vias`, `familias`;
- `solicitudes`, `solicitud_eventos` (historial auditable), `eventos_vistos`;
- `propuestas_cita`, `franjas_agenda`, `entrevistas`, `tokens_publicos`, `documentos`;
- `plantillas_correo`, `correos_salientes`, `reservas`, `cobros`, `secuencias`;
- `alumnas`, `alumna_contactos`, `alumna_eventos`;
- `matriculas`, `enlaces_matricula`, `matricula_eventos`.

| Migración | Contenido |
|---|---|
| `0000_inicial` | Esquema base |
| `0001_agenda_sin_solapes` | A mano: restricción `EXCLUDE` |
| `0002_avisos_familia` | `eventos_vistos` |
| `0003_reserva_y_cobros` | `reservas`, `cobros`, enumerados y `solicitudes.en_espera_desde` |
| `0004_reservas_admitidas_antiguas` | A mano, solo datos |
| `0005_propuesta_cancelada_familia` | Valor `CANCELADA` en `estado_propuesta` (la familia cancela su cita) |
| `0006_ficha_entrevista` | `entrevistas.ficha` (jsonb): ficha de la entrevista de la solicitud en papel |
| `0007_alumnado` | `alumnas`, `alumna_contactos`, `alumna_eventos` y sus enumerados |
| `0008_alumnas_reservas_antiguas` | A mano, solo datos: expediente para las solicitudes con la plaza ya reservada o matriculadas |
| `0009_matricula` | `matriculas`, `enlaces_matricula`, `matricula_eventos` y los enumerados `estado_matricula` y `alcance_enlace` |

## Convenciones

- **Errores:** lanzar `AppError` con los helpers de `lib/errors.ts` (`badRequest`, `conflict`, `gone`…). La respuesta siempre es `{ error: { code, message, details? } }`, con `message` en español apto para un toast. Una ruta inexistente responde 404 `RUTA_NO_ENCONTRADA`.
- **Validación:** `validate({ body, query, params })` con Zod y lectura tipada con `v<typeof schema>(req, 'body')`.
- **Permisos:** `requirePermiso('modulo.accion')`; el catálogo está en `modules/permisos/catalogo.ts`. Nunca comprobar roles por nombre en las rutas.
- **Transacciones:** los servicios reciben `tx: Tx`. Los cambios de estado de una solicitud pasan por `cambiarEstado()` (control optimista + evento en `solicitud_eventos`).
- **Correos:** nunca enviar directo. Siempre `enviarEvento(tx, 'EVENTO', { para, vars, solicitudId, adjuntos })` dentro de la misma transacción (outbox). Para una vista previa con datos reales, `prepararEvento`.
- **Fechas:** en BD todo es `timestamptz` UTC, y las fechas de pago son `date` (`AAAA-MM-DD`). Para formatear o interpretar horas del centro, usar `lib/fechas.ts` (`horaLocalAUtc`, `diaLargo`, `fechaLocal`…).
- **Importes:** siempre en céntimos (enteros) en BD y en la API; el texto para mostrar con `euros()` de `lib/dinero.ts`. IBAN validado con `ibanValido`.
- **Kanban:** cada tarjeta trae `siguientes` (`siguientesEstados` en `dominio.ts`). Un destino con efectos (citar, pedir que complete, decidir, registrar cobro) lleva `accion` y no se mueve con `PATCH /estado`.
- **Enlaces públicos:** tokens aleatorios; en BD solo se guarda su hash (`crearToken`, `hashToken`).
- **Textos visibles** (estados, comprobaciones, página de cita, títulos del kanban): copiados de los mockups, sin inventar etiquetas. Si un texto no cuadra, se apunta en `preguntas-abiertas.md` y se mantiene el del mockup hasta que el cliente decida.

## Trampas conocidas (ya nos han mordido)

1. **Zod 4 + `.partial()` conserva los `.default()`.** Un PATCH parcial restablece campos sin querer. Para editar, define un esquema con `.optional()` explícitos y sin defaults (ver `comunicaciones.routes.ts › editarBody`).
2. **Drizzle envuelve los errores de PostgreSQL** (`DrizzleQueryError`) y deja el código en `error.cause.code`. Usa siempre `codigoPg(e)`, nunca `e.code`.
3. **Agenda:** la restricción `EXCLUDE` (`0001`) produce el error `23P01`: usar `esSolape(e)` y responder 409. Si regeneras la `0000`, vuelve a crear la `0001` a mano (`drizzle-kit generate --custom`).
4. **No hacer `Promise.all` dentro de una transacción.** Todas las consultas comparten conexión: `pg` avisa y en `pg@9` fallará. En serie dentro de `tx`; en paralelo solo fuera, sobre `db` (pool).
5. **Alias en SQL crudo:** dentro de `` sql`…` ``, `${alias}` se escribe solo como `"alias"`. Hay que poner `from ${tabla} ${alias}` (ver el filtro `familiaVinculada`).
6. **Microsegundos:** PostgreSQL guarda microsegundos y JavaScript milisegundos. Comparar un `timestamptz` con un `Date` de JS en un `where` no coincide nunca.
7. **`euros()`** usa un espacio de no separación (U+00A0) antes de «€». En los tests, `'300,00 €'`.
8. **Límite del formulario público:** 10 envíos por hora y por IP, y cuentan también los rechazados. En los tests crea solicitudes con el alta interna (`POST /solicitudes`), no con el formulario público.
9. **El `.env` local se cuela en los tests** (dotenv). Toda variable que afecte a un test hay que fijarla en `vitest.config.mts › test.env`.
10. **Plantillas al arrancar:** `sembrarBase` crea las que faltan. Una plantilla que **nadie ha editado** (`actualizado_por_id` nulo y única de su evento) se pone al día con la predeterminada actual, así que los cambios de texto de `eventos.ts` llegan también a las BD existentes; si es de un evento ya construido y estaba en borrador, además se activa. Si el centro la tocó (guardar, activar o pasar a borrador desde Comunicaciones), no se cambia.
11. **Roles al arrancar:** `sembrarBase` no pisa roles existentes. Un permiso nuevo en una BD ya creada se añade desde la matriz o con una migración.
12. **Contenedor:** la API arranca como root solo para ajustar los permisos de `storage/uploads` y luego pasa a `node`.
13. **Una entrevista futura no se puede marcar como realizada** (409 `ENTREVISTA_FUTURA`). En pruebas manuales, la solicitud se pasa a `ENTREVISTA_REALIZADA` con `PATCH /estado` (transición manual permitida).
14. **`UPDATE … RETURNING` no devuelve las filas en ningún orden.** Si importa el orden (la cola de correos), se recorre el de la `SELECT … ORDER BY`. Y `now()` es el mismo durante toda la transacción: para desempatar filas creadas en la misma, `clock_timestamp()` (ver `encolarCorreo`). Sin esto, dos correos a la misma familia podían salir al revés y 6 tests fallaban de vez en cuando.
15. **`jsonb` no conserva el orden de las claves.** Comparar un JSON leído de la BD con el que llega en la petición usando `JSON.stringify` da «distintos» aunque sean iguales. Usa `jsonCanonico` (`matricula.service.ts`), que ordena las claves. Sin esto, el autoguardado de la matrícula subía la versión en cada guardado sin cambios.

## Reglas de negocio validadas con el cliente

- **Perfiles:** Dirección (superadministrador, todos los permisos, no se le pueden quitar), Administración, Secretaría y Comercial/Promoción. Matriz editable por Dirección. Siempre debe quedar un usuario activo de Dirección. Solo Dirección registra la decisión de admisión (`evaluacion.editar`).
- **Solicitud web:** obligatorios alumna (nombre y apellidos), vía, centro de procedencia, tutor, correo y teléfono; la modalidad es opcional. Entra como `RECIBIDA` y se envía un acuse.
- **Revisión:** cinco comprobaciones (datos completos, correo válido, plazas libres por vía, familia ya vinculada, cupo SNEC). No se puede citar si está incompleta: se usa "Pedir que complete".
- **Agenda:** jornada de lunes a viernes de 8:00 a 18:00. Entrevistas de 45 o 60 min, siempre **presenciales con el equipo directivo** en la sala de reuniones de Dirección. **Nunca el mismo día** (21/10/2026): la disponibilidad marca las horas de hoy como `Mismo día` y `citar` responde 400 `FECHA_MISMO_DIA`; se controla con `permitirMismoDia` (por defecto `false`) en `ajustes.agenda`.
- **Citación:** 1 a 3 fechas reservadas hasta que la familia elige. Al elegir, la elegida se confirma, las demás se liberan y la entrevista aparece en el calendario (.ics por correo).
- **Cambio de cita:** solo durante las **24 h siguientes a la primera aceptación**. Después, 409 `CAMBIO_FUERA_DE_PLAZO`.
- **Recordatorios:** uno si la familia no elige en 3 días, y otro el día antes de la entrevista.
- **Notas del último curso:** se piden con la cita y se suben desde el mismo enlace.
- **Plazas:** ocupan plaza las solicitudes admitidas, con plaza reservada y matriculadas. El cupo SNEC es informativo.
- **Reserva (21/10/2026):**
  - 300 € para todas las vías (configurable);
  - IBAN provisional `ES91 2100 0418 4502 0005 1332` (ficticio);
  - transferencia y efectivo;
  - conciliación con registro manual;
  - 15 días naturales desde la admisión.
- **Kanban:** el embudo cuenta todo; la bandeja es la vista de lo que requiere acción. Siempre presencial con el equipo directivo: no hay filtro de entrevistador. La cita la confirma la familia, no secretaría.

## Lo que falta

### Impacto de la reunión del 21/10/2026 (pendiente de implementar)

Detalle, flujo de referencia paso a paso y prioridad en `../RESUMEN-PROYECTO-ALBAYDAR.md` y `../docs/diagrama-flujo-admision.png` (fuera del repo, en `albaydar-project/`). Lo que toca a la API:

- ~~**Código con letra de tipo:** B Bachillerato, C Ciclos~~ ✅ hecho en `feat/codigo-solicitud-por-tipo`: `B-2026-0001` / `C-2026-0001`, contador por letra y año (`siguienteCodigo` y `LETRA_CODIGO` en `solicitudes/comun.ts`). Formato provisional hasta que el cliente dé sus series; las anteriores conservan `SOL-…`.
- **Varios entrevistadores (~7, según el tipo de solicitud)** y calendario de todos para secretaría, con Google Calendar como opción. **Revierte la decisión D2** (agenda única del equipo directivo, `CHECK entrevistas_presencial_chk`, `EXCLUDE` global): entrevistador por entrevista y agenda por persona. Esperar la lista de entrevistadores antes de migrar.
- ~~**Cancelar desde el recordatorio del día antes** y desde `/cita/:token`, con aviso a secretaría; respuestas por correo a secretaría~~ ✅ hecho en `feat/cancelar-cita-familia`: `POST /public/citas/:token/cancelar` (`cancelarPorFamilia`), propuesta `CANCELADA` (migración `0005`), aviso `CITA_CANCELADA_FAMILIA` en `respuestas-familia`, correo `AVISO_CANCELACION_FAMILIA` y `Reply-To` (`MAIL_REPLY_TO` o `MAIL_SECRETARIA`). Falta el front: botón en la página de la cita, estado «cancelada» y el aviso en la bandeja.
- ~~**Entrevista previa ya realizada:** validarla sin repetirla~~ ✅ hecho en `feat/entrevista-previa`: `POST /solicitudes/:id/entrevista-previa` (`registrarEntrevistaPrevia` en `citacion.service.ts`) y acción `REGISTRAR_ENTREVISTA_PREVIA` en `siguientes`. Falta la acción en el front.
- ~~**Duración y antelación:** 45–60 min y nunca el mismo día~~ ✅ hecho en `fix/agenda-sin-mismo-dia` (`primerInicioPermitido` en `agenda.service.ts`).
- **Reserva no reembolsable** salvo fuerza mayor caso por caso (cierra la pregunta 15); se puede pagar desde diciembre.
- **Captación / CRM:** primer contacto con nombre, correo, teléfono y área de interés, y correo automático de información en menos de 5 min. El flujo completo y el perfil Comercial los define el cliente (Luis Fdo.).
- **Matrícula (sigue en pausa), dos bloqueos nuevos:** alumnado de la Junta de Andalucía directo a matrícula con **importación desde Séneca** (API o fichero), y renovación 1º→2º filtrando a quien promociona según calificaciones (requiere Alumnado y notas).
- **Untis:** sesión aparte para decidir si se integra o se sustituye.
- Los dos bloqueos de matrícula de esta reunión (alumnado de la Junta y renovación según promoción) quedan recogidos en el punto 8 de `docs/matricula.md`.

### Fase 04 · Matrícula digital (en curso)

**Entrega 1 hecha el 08/11/2026** (ver «Qué está implementado»). Quedan las entregas 2 (documentos con huella, firmas y mandatos SEPA), 3 (archivos, envío, PDF y Séneca) y 4 (front), en `docs/matricula.md` → «Entregas».

El front ya tiene el asistente completo contra una API simulada (`mock-enrollments.interceptor.ts`). Las reglas están en `src/app/domain/rules/enrollment.rules.ts` del front (unas 770 líneas: `stepMissing`, `canSignDoc`, `voidedMandateSignatures`, `economicLines`, `checklist`, `canSubmit`) y son la especificación que la API tendrá que validar.

Lo que propuso el front:
- **Matrícula precargada** al pagar la reserva (alumna, vía, curso, tutor, contacto y centro de procedencia), más alta manual para el alumnado de 2º que continúa.
- **Borrador** con autoguardado.
- **Archivos:**
  - foto de carné;
  - checklist `m1`–`m5`, `c1`, `c2`, `b1`, `b2`, `e1`, `p1`.
- **Firmas en PNG** con fecha y hora del servidor: `impreso-titular`, `ideario-titular`, `lopd-padre`, `lopd-madre`, `lopd-img-padre`, `lopd-img-madre`, `lopd-pd-padre`, `lopd-pd-madre`, `sepa-titular` y `plus-titular`.
- **Envío y Séneca:** envío con validación completa y exportación a Séneca (CSV provisional).
- **Portal de la familia:** `/matricula/:token`, con secretaría como respaldo.
- **Estados:** `BORRADOR` → `ENVIADA` → `EXPORTADA` (la solicitud pasa a `MATRICULADA` y se envía `MATRICULA_CONFIRMADA`), con vuelta a borrador si secretaría la devuelve.

**Bloqueos decididos el 08/11/2026.** El diseño completo, con el porqué de cada punto, está en `docs/matricula.md`: léelo antes de tocar Matrícula o Alumnado. Las respuestas del centro van a las preguntas 23–28 de `preguntas-abiertas.md`, y el diseño ya admite cualquiera de ellas.

1. **Documentos firmados**
   - El texto de los documentos lo da la API: textos legales versionados en código, no plantillas editables. El lector del front pinta lo que recibe.
   - Cada firma guarda la huella SHA-256 del contenido canónico (versión del texto + datos), la hora del servidor, la IP, el navegador y el enlace. Si la huella ya no coincide, 409 `DOCUMENTO_CAMBIADO`.
   - Una firma vale mientras su huella coincida: si cambian los datos, se anula y hay que volver a firmar.
   - Al enviar, se genera el PDF final con `pdfkit`, con los trazos y una hoja de evidencias.
2. **«Páginas leídas»:** firma electrónica simple. Se registra con la hora del servidor y se declara, nunca se afirma que se haya leído. Firmar exige `canSignDoc`.
3. **Padre y madre:** varios enlaces por matrícula, cada uno con su alcance (`FAMILIA` o `PROGENITOR`). Por defecto, uno solo; cada firma registra su enlace. Lo decide el centro (pregunta 23).
4. **SEPA**
   - Tabla `mandatos_sepa`; referencia `M-2027-0001-SEPA1`, que nunca se reutiliza; `RCUR` / `OOFF`, esquema `CORE`.
   - IBAN validado con módulo 97 y enmascarado fuera de la ficha.
   - Acreedores por vía en `ajustes.matricula`. `ES09000G41829037` es correcto; el de GS concertado está por confirmar (pregunta 24).
5. **Edición simultánea:** `matriculas.version`, y 409 `VERSION_ANTIGUA` si se guarda sobre una versión antigua. Firmas y archivos no suben la versión.
6. **Límites del portal**, por enlace (no por IP): autoguardado 900 cada 15 min, firmas 60/h, archivos 30/h. En el front, autoguardado a 1 s.
7. **Ficheros de menores**
   - Google Cloud Storage en `europe-southwest1`, detrás de `Almacen`.
   - `conservarHasta` por tipo de fichero y tarea diaria de borrado. Plazos propuestos en la pregunta 25; no se borra nada hasta que se confirmen.
8. **Alumnado primero**
   - La matrícula lleva `alumnaId` obligatorio y `solicitudId` opcional, una por alumna y curso escolar.
   - Orígenes: reserva pagada, renovación 1º → 2º (solo quien `promociona`), alumnado de la Junta importado de Séneca y alta manual.
9. **Séneca:** adaptador `exportarSeneca` con CSV provisional hasta que llegue el formato oficial (pregunta 28).

### Otros módulos sin empezar

- **Alumnado:** falta la importación de Séneca (alumnado de la Junta y carga inicial de 1º, pregunta 27).
- **Cobros completos:**
  - conceptos más allá de la reserva (matrícula, mensualidad, AMPA, uniforme, cuota reglada, AlbaydarPLUS) — cada uno con su tratamiento de IVA;
  - remesas SEPA;
  - conciliación;
  - facturación;
  - devoluciones.

  En el front están simulados y marcados «Propuesta a validar con el centro».
- **Configuración y Comunicaciones en el front:** la API ya tiene usuarios, matriz de permisos, horario de agenda, configuración de la reserva y plantillas; faltan esas pantallas en el front.

### Pendiente del cliente (`docs/preguntas-abiertas.md`)

**Agenda y citas**
- liberar automáticamente las reservas de fechas sin respuesta;
- confirmar el plazo de 24 h;
- paso de 30 min y antelación de 2 h;
- festivos;
- una agenda o varias;
- sincronización con Google o Outlook.

**Solicitud**
- regla de "familia ya vinculada";
- curso escolar de destino de las solicitudes.

**Permisos:** perfil Comercial.

**RGPD**
- plazo de conservación de los datos de no admitidas;
- texto de la casilla de privacidad.

**Kanban:** título de la primera columna (el mockup dice "Solicitud revisada"; el front propone "Nuevas y en revisión").

**Matrícula**
- uno o dos enlaces para las firmas de padre y madre;
- identificador de acreedor SEPA de GS concertado;
- plazos de conservación de los documentos;
- volver a firmar si cambian los datos de un documento firmado;
- listado de alumnas de 1º desde Séneca;
- formato del fichero de Séneca.

**Reserva y cobros**
- qué hacer con una reserva vencida;
- devolución de la reserva;
- numeración de recibos por año o por curso escolar, y si el centro ya usa otra herramienta para emitirlos;
- textos de los correos de lista de espera y no admitida (hoy provisionales);
- IBAN real;
- razón social y NIF del centro para el recibo.

### Técnico, antes de producción

- **Correo:** remitente propio del centro (p. ej. `admisiones@albaydar.org`) con su servidor; Gmail solo vale para la demo. Rotar la contraseña de aplicación de Gmail usada en desarrollo.
- **Nube para ficheros** en la UE: implementar `lib/storage.ts` (hoy carpeta local).
- **Despliegue:**
  - API en `/api` del mismo dominio que el front, sin reescribir la ruta (la cookie de refresco va en `path=/api/auth`);
  - `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`;
  - `JWT_ACCESS_SECRET` aleatorio;
  - `SEED_DEMO=false`.
- **Semilla de demo:** opcionalmente, ampliarla (~40 solicitudes en todos los estados) para demos.
- **Posible mejora:** que secretaría pueda adjuntar el boletín de notas ella misma (hoy solo la familia, desde su enlace).
- **Deuda menor:** `z.string().uuid()` y `.email()` están obsoletos en Zod 4 (se usan en todo el código, migrar de una vez a `z.uuid()` y `z.email()`); avisos de estilo de Sonar (`await` en bucles intencionado en las tareas, ternarios anidados).

## Cómo trabajar en este repo

- **Ramas** (desde el 27/10/2026, igual que el front): `develop` es la rama de trabajo y la de por defecto en GitHub. Todo sale de `develop` en una rama `feat/…`, `fix/…`, `chore/…` o `docs/…` y vuelve a `develop` mediante PR. Cuando se completan varias iteraciones, `develop` → `main` con un PR. No se abren PR de funcionalidades contra `main`. Commits y PR, solo cuando el usuario lo pida.

- **Cambio de contrato:**
  1. Actualiza `docs/api.md` en el mismo cambio.
  2. Si afecta al front, prepara un resumen para pasárselo: qué cambia, qué rompe, ejemplos JSON reales.
  3. El front responde con lo que le falta; se cierra en una iteración más.
- **Cambio de esquema:** edita `schema.ts` → `npm run db:generate -- --name …` → revisa el SQL → tests. Los cambios solo de datos van con `drizzle-kit generate --custom` (como la `0004`). Nunca edites `drizzle/meta/` a mano.
- **Nuevo correo:**
  1. Añade el evento a `src/correo/eventos.ts` (variables + predeterminada, `disponible: true`).
  2. Llama a `enviarEvento` desde el servicio.
  3. `sembrarBase` crea la plantilla al arrancar.

  Hay un test que comprueba que las predeterminadas solo usan variables declaradas.
- **Nuevo módulo con permisos:** añádelo a `MODULOS` y `ROLES_INICIALES` en `permisos/catalogo.ts` (ojo con la trampa 11).
- **Tests:** `tests/flujo-admision.test.ts` recorre el flujo por HTTP. Los bloques de la fase 03 usan un helper `evaluada()`, que crea una solicitud y la pone en `ENTREVISTA_REALIZADA`, y atajos directos a la BD para fechas (plazos, recordatorios). Los correos se capturan con un transporte falso (`buzon`).
- **Decisiones de producto:** no las tomes en silencio. Si algo no está en los mockups ni en las reglas validadas, propón un valor por defecto, apúntalo en `docs/preguntas-abiertas.md` y avisa.
