# Albaydar API · contexto para Claude Code

API de la plataforma de gestión académica del **Centro Educativo Albaydar** (Sevilla; Bachillerato y FP). La consume un front en **Angular 19** (repo `Ceroone-Technology/app-albaydar-front`). Los mockups HTML validados con el cliente son la especificación funcional. Responde y documenta **en español**.

Este archivo es el punto de partida para cualquier sesión: qué hay, cómo se trabaja, qué falta y qué trampas ya conocemos. Antes de tocar algo, lee también `docs/api.md` (contrato con el front), `docs/flujo-y-datos.md` (estados, reglas, modelo) y `docs/preguntas-abiertas.md` (decisiones del cliente y lo pendiente).

## Estado en una mirada

| Fase (diagrama de flujo del cliente) | Estado |
|---|---|
| 01 · Captación (formulario web, alta interna) | ✅ Hecha |
| 02 · Revisión y entrevista (bandeja, kanban, citación, agenda, entrevistas) | ✅ Hecha |
| 03 · Evaluación y reserva de plaza (decisión, reserva, cobros manuales) | ✅ Hecha |
| 04 · Matrícula digital (asistente, firmas, documentos, Séneca) | ⏸️ **En pausa** por decisión del equipo. No empezar sin cerrar sus bloqueos (ver «Lo que falta») |
| Cobros completos (remesas SEPA, conciliación, facturación), Alumnado | ❌ Sin empezar |

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
npm test                         # 85 tests; usa la BD albaydar_test (la crea el contenedor de PostgreSQL)
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
  - ⚠️ Las 3 solicitudes de ejemplo de la semilla usan correos `@correo.es`, un dominio real. No las cites ni les envíes nada. Está pendiente pasarlas a `@example.com`.
  - Para probar, usa alias propios (`buzon+prueba1@gmail.com`).
- **Ficheros subidos:** carpeta `storage/uploads` del equipo (ignorada por git; puede contener boletines reales de prueba).

## Estructura

```
src/
  app.ts                 Express: helmet, CORS con credenciales, rutas públicas (/auth, /public) y privadas (requireAuth por prefijo → una ruta inexistente da 404, nunca 401)
  config/env.ts          variables validadas con Zod + CENTRO (nombre, dirección, teléfono, logo, datos de la entrevista)
  db/schema.ts           esquema (fuente de verdad) · migrate.ts · seed.ts (demo) · datos-base.ts (roles, plantillas, ajustes; también en producción)
  lib/                   db, fechas (única conversión UTC ↔ Europe/Madrid), dinero (euros, IBAN), errores, crypto, storage, logger
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
    comunicaciones/      plantillas (CRUD, vista previa, prueba), histórico de envíos, estado SMTP
    documentos/ publico/ catalogo/
drizzle/                 migraciones SQL (0000–0004) y meta/ (journal + snapshots: no se editan a mano)
docs/                    api.md · flujo-y-datos.md · preguntas-abiertas.md · gmail.md
tests/                   reglas.test.ts (funciones puras) · flujo-admision.test.ts (HTTP contra PostgreSQL real, SMTP falso)
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

**Fase 03: evaluación, reserva y cobros** (detalle en `docs/api.md`)
- `POST /solicitudes/:id/decision` (`evaluacion.editar`):
  - **Admitida:** crea la reserva y notifica con importe, IBAN y fecha límite.
  - **En espera:** posición automática por vía.
  - **No admitida:** motivo.

  Arrastrar a una decisión responde 409 `ACCION_REQUERIDA` con `accion: "DECIDIR"`.
- `POST /solicitudes/:id/decision/previsualizar`: el correo que recibiría la familia, con sus datos reales, sin cambiar nada.
- **Reserva:** 300 € por defecto, con excepciones por vía; 15 días naturales; transferencia o efectivo. IBAN provisional y ficticio, validado. Todo en `ajustes.reserva`, vía `GET/PUT /reservas/configuracion`.
- **Control de reservas:** `GET /reservas?porVencer=true`, con días restantes. "Recordar" (`POST /reservas/:id/recordar`), con un mínimo de 1 h entre envíos.
- **Recordatorio automático** a 3 días del plazo, uno solo, que no sale si ya se usó "Recordar". Vencida: aviso a secretaría y administración; la plaza no se libera sola y el pago tardío se acepta.
- **Cobros manuales** (`POST /cobros`):
  - recibo `R-AAAA-NNNN` correlativo por año; pagos parciales; nunca más de lo pendiente;
  - al cubrir la reserva, en la misma transacción, la reserva queda `PAGADA` y la solicitud pasa a `PLAZA_RESERVADA`;
  - un cobro no se borra: se anula con motivo, y si la reserva queda sin cubrir, la solicitud vuelve a `ADMITIDA`.
- `GET /cobros` (pestaña Pagos), `GET /cobros/resumen` (KPIs: cobrado, pendiente, parcial) y `GET /cobros/:id/recibo` (HTML imprimible, con mención de exención de IVA, art. 20.Uno.9.º LIVA).
- La migración `0004` creó la reserva de las solicitudes admitidas antes de la fase 03, sin enviar correo.

**Comunicaciones**
- Todos los correos salen de plantillas HTML editables, una activada por evento. Saneado al guardar y variables validadas. Vista previa, prueba e histórico.
- Eventos:
  - `SOLICITUD_RECIBIDA`, `COMPLETAR_SOLICITUD`*, `CITACION_PROPUESTA`*, `CITACION_RECORDATORIO`, `CITA_CONFIRMADA`*, `CITA_CAMBIADA`*, `ENTREVISTA_RECORDATORIO`, `CITA_CANCELADA`, `AVISO_OTRA_FRANJA`;
  - de la fase 03: `ADMITIDA`, `EN_ESPERA`, `NO_ADMITIDA`, `RECORDATORIO_PAGO`, `RESERVA_VENCIDA`;
  - en borrador: `MATRICULA_CONFIRMADA`.

  (*) Obligatorios: llevan el enlace de la familia y se envían aunque la plantilla esté en borrador.
- Correo con outbox: se guarda en la misma transacción y un worker lo envía cada 15 s, con reintentos.

## Modelo de datos y migraciones

Tablas:
- `usuarios`, `refresh_tokens`, `roles`, `ajustes`, `vias`, `familias`;
- `solicitudes`, `solicitud_eventos` (historial auditable), `eventos_vistos`;
- `propuestas_cita`, `franjas_agenda`, `entrevistas`, `tokens_publicos`, `documentos`;
- `plantillas_correo`, `correos_salientes`, `reservas`, `cobros`, `secuencias`.

| Migración | Contenido |
|---|---|
| `0000_inicial` | Esquema base |
| `0001_agenda_sin_solapes` | A mano: restricción `EXCLUDE` |
| `0002_avisos_familia` | `eventos_vistos` |
| `0003_reserva_y_cobros` | `reservas`, `cobros`, enumerados y `solicitudes.en_espera_desde` |
| `0004_reservas_admitidas_antiguas` | A mano, solo datos |

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
10. **Plantillas al arrancar:** `sembrarBase` crea las que faltan. Si una plantilla de un evento ya construido sigue en borrador **sin haberse editado nunca**, la sustituye por la predeterminada y la activa. Si el centro la tocó, no la cambia.
11. **Roles al arrancar:** `sembrarBase` no pisa roles existentes. Un permiso nuevo en una BD ya creada se añade desde la matriz o con una migración.
12. **Contenedor:** la API arranca como root solo para ajustar los permisos de `storage/uploads` y luego pasa a `node`.
13. **Una entrevista futura no se puede marcar como realizada** (409 `ENTREVISTA_FUTURA`). En pruebas manuales, la solicitud se pasa a `ENTREVISTA_REALIZADA` con `PATCH /estado` (transición manual permitida).
14. **`UPDATE … RETURNING` no devuelve las filas en ningún orden.** Si importa el orden (la cola de correos), se recorre el de la `SELECT … ORDER BY`. Y `now()` es el mismo durante toda la transacción: para desempatar filas creadas en la misma, `clock_timestamp()` (ver `encolarCorreo`). Sin esto, dos correos a la misma familia podían salir al revés y 6 tests fallaban de vez en cuando.

## Reglas de negocio validadas con el cliente

- **Perfiles:** Dirección (superadministrador, todos los permisos, no se le pueden quitar), Administración, Secretaría y Comercial/Promoción. Matriz editable por Dirección. Siempre debe quedar un usuario activo de Dirección. Solo Dirección registra la decisión de admisión (`evaluacion.editar`).
- **Solicitud web:** obligatorios alumna (nombre y apellidos), vía, centro de procedencia, tutor, correo y teléfono; la modalidad es opcional. Entra como `RECIBIDA` y se envía un acuse.
- **Revisión:** cinco comprobaciones (datos completos, correo válido, plazas libres por vía, familia ya vinculada, cupo SNEC). No se puede citar si está incompleta: se usa "Pedir que complete".
- **Agenda:** jornada de lunes a viernes de 8:00 a 18:00. Entrevistas de 45 o 60 min, siempre **presenciales con el equipo directivo** en la sala de reuniones de Dirección.
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

- **Código con letra de tipo:** **B** Bachillerato, **C** Ciclos. Se deriva de `vias.familia` en `siguienteCodigo()` (`solicitudes/comun.ts`), con secuencia por letra y año. Series exactas pendientes del cliente.
- **Varios entrevistadores (~7, según el tipo de solicitud)** y calendario de todos para secretaría, con Google Calendar como opción. **Revierte la decisión D2** (agenda única del equipo directivo, `CHECK entrevistas_presencial_chk`, `EXCLUDE` global): entrevistador por entrevista y agenda por persona. Esperar la lista de entrevistadores antes de migrar.
- **Cancelar desde el recordatorio del día antes** y desde `/cita/:token`, con aviso a secretaría. Si la familia responde al correo para cancelar o cambiar, debe llegar a secretaría: en v1, `Reply-To` al buzón de secretaría; leer el buzón entrante, más adelante.
- **Entrevista previa ya realizada:** validarla sin repetirla (hoy solo el atajo `PATCH /estado`).
- **Duración y antelación:** 45–60 min (se mantiene) y **nunca el mismo día**: hoy la disponibilidad solo exige 2 h de antelación.
- **Reserva no reembolsable** salvo fuerza mayor caso por caso (cierra la pregunta 15); se puede pagar desde diciembre.
- **Captación / CRM:** primer contacto con nombre, correo, teléfono y área de interés, y correo automático de información en menos de 5 min. El flujo completo y el perfil Comercial los define el cliente (Luis Fdo.).
- **Matrícula (sigue en pausa), dos bloqueos nuevos:** alumnado de la Junta de Andalucía directo a matrícula con **importación desde Séneca** (API o fichero), y renovación 1º→2º filtrando a quien promociona según calificaciones (requiere Alumnado y notas).
- **Untis:** sesión aparte para decidir si se integra o se sustituye.

### Fase 04 · Matrícula digital (en pausa)

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

**Bloqueos que hay que resolver antes de empezar** (si se hacen después, obligan a rehacer el modelo):
1. **Documentos que se firman generados en el servidor** (impreso, ideario, LOPD, SEPA, AlbaydarPLUS) en PDF. Con cada firma se guarda la huella (hash) del documento exacto, la fecha y hora del servidor, la IP y el token. Sin esto, la firma es un PNG suelto.
2. **"Páginas leídas":** el servidor no puede comprobarlo, solo registrar lo que dice el front (firma electrónica simple).
3. **Firmas de padre y madre por un único enlace:** no se sabe quién firma cada una. Hay que decidir si basta o si se da un enlace a cada progenitor.
4. **SEPA:** identificador de acreedor del centro (en ajustes), referencia única de mandato, fecha de firma, tipo de mandato (recurrente o único) y validación del IBAN.
5. **Edición simultánea** de familia y secretaría: número de versión con 409 si se guarda sobre una versión antigua (no "la última escritura gana").
6. **Límite de peticiones propio** para el autoguardado del portal de la familia: el actual de las rutas públicas (10 por hora) lo bloquearía.
7. **Documentos sensibles** de menores (DNI, Libro de Familia, tarjeta sanitaria): almacenamiento en la nube en la UE y plazo de conservación (RGPD).
8. **Alumnado de 2º que continúa:** necesita el módulo de Alumnado. La matrícula debe poder existir sin solicitud.
9. **Formato oficial del fichero de Séneca.**

### Otros módulos sin empezar

- **Alumnado:** alumnas matriculadas. La comprobación "familia ya vinculada" también tendrá que mirar contra ellas, y es la base del alumnado que continúa.
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
- **Semilla de demo:** pasar los correos `@correo.es` a `@example.com`, y opcionalmente ampliarla (~40 solicitudes en todos los estados) para demos.
- **Posible mejora:** que secretaría pueda adjuntar el boletín de notas ella misma (hoy solo la familia, desde su enlace).
- **Deuda menor:** `z.string().uuid()` y `.email()` están obsoletos en Zod 4 (se usan en todo el código, migrar de una vez a `z.uuid()` y `z.email()`); avisos de estilo de Sonar (`await` en bucles intencionado en las tareas, ternarios anidados).

## Cómo trabajar en este repo

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
