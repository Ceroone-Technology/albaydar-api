# Contrato de la API para el front Angular

Base: `/api`. JSON en todas las respuestas. Fechas en ISO 8601 (UTC); la API devuelve también los textos ya formateados en hora de Madrid (`dia`, `franja`, `day`, `time`) tal como los muestran los mockups.

## Errores

Siempre con la misma forma, para un interceptor único en Angular:

```json
{ "error": { "code": "FRANJA_OCUPADA", "message": "Ya no está libre: Lunes 2 de noviembre · 11:00 – 12:00…", "details": {} } }
```

`message` está en español y se puede mostrar tal cual en el toast. `code` es estable para ramificar.

| HTTP | Cuándo | Códigos habituales |
|---|---|---|
| 400 | Datos inválidos | `DATOS_INVALIDOS` (con `details: [{campo, mensaje}]`), `FUERA_DE_HORARIO`, `DURACION_NO_VALIDA`, `VARIABLES_DESCONOCIDAS`, `ROL_DESCONOCIDO`, `IMPORTE_SUPERIOR_AL_PENDIENTE`, `METODO_NO_ADMITIDO`, `FECHA_FUTURA` |
| 401 | Sin sesión o caducada | `NO_AUTENTICADO`, `TOKEN_CADUCADO` → llamar a `/auth/refresh`, `CREDENCIALES_INVALIDAS`, `SESION_REVOCADA`, `SESION_CADUCADA` |
| 403 | Falta el permiso | `SIN_PERMISO` |
| 404 | No existe | `RUTA_NO_ENCONTRADA` (la ruta no existe: nunca es 401, así que no debe cerrar la sesión), `SOLICITUD_NO_ENCONTRADA`, `ENLACE_NO_VALIDO` |
| 409 | Conflicto de negocio | `SOLICITUD_INCOMPLETA`, `FRANJA_OCUPADA`, `HUECO_NO_DISPONIBLE`, `CAMBIO_FUERA_DE_PLAZO`, `ACCION_REQUERIDA`, `TRANSICION_NO_PERMITIDA`, `ULTIMO_SUPERADMIN`, `SIN_RESERVA_PENDIENTE`, `RESERVA_CON_COBROS`, `COBRO_YA_ANULADO`, `RESERVA_NO_PENDIENTE`, `RECORDATORIO_RECIENTE`, `RECORDATORIO_NO_ENVIADO` |
| 410 | Enlace público ya no vale | `PROPUESTA_SUSTITUIDA`, `ENLACE_CADUCADO`, `ENLACE_USADO` |
| 423 | Cuenta bloqueada 15 min | `CUENTA_BLOQUEADA` |
| 429 | Límite de peticiones | `DEMASIADAS_PETICIONES` |

## Autenticación

- **Access token** (JWT, 15 min) en memoria del front, nunca en `localStorage`. Se envía como `Authorization: Bearer …`.
- **Refresh token** en cookie `alb_rt` httpOnly, `path=/api/auth`. El front solo llama con `withCredentials: true`.
- Rotación: cada `/refresh` emite cookie nueva; si alguien reutiliza una antigua se cierra la sesión entera (`SESION_REVOCADA`).
- 5 intentos fallidos → bloqueo de 15 minutos.

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | `{ accessToken, usuario }` + cookie |
| POST | `/auth/refresh` | — (cookie) | igual que login |
| POST | `/auth/logout` | — | 204 |
| GET | `/auth/me` | — | `{ usuario }` |
| POST | `/auth/cambiar-password` | `{ actual, nueva }` | igual que login (cierra el resto de sesiones) |

`usuario` trae los permisos efectivos para pintar el menú y los botones:

```json
{
  "id": "…", "email": "maria.reyes@albaydar.org", "nombre": "María Reyes",
  "roles": ["SECRETARIA"], "superadmin": false,
  "permisos": ["dashboard.ver", "alumnado.ver", "alumnado.editar", "solicitudes.ver", "solicitudes.editar", "entrevistas.ver", "…"]
}
```

**Al arrancar la app** Angular llama a `/auth/refresh`: si hay cookie válida, recupera la sesión sin pedir contraseña. **Interceptor:** ante 401 `TOKEN_CADUCADO`, una sola llamada a `/auth/refresh` (compartida entre peticiones simultáneas) y reintento.

## Roles y permisos

Cuatro perfiles acordados con el cliente. **Dirección** es superadministrador: tiene todo y no se le puede quitar. El resto se configura en una matriz módulo × rol con **ver** y **editar** (editar implica ver):

| Módulo (`id`) | Dirección | Secretaría | Administración | Comercial |
|---|---|---|---|---|
| `dashboard` | ver/editar | ver | ver | ver |
| `alumnado` | ver/editar | ver/editar | ver | ver |
| `solicitudes` | ver/editar | ver/editar | — | ver/editar |
| `entrevistas` | ver/editar | ver/editar | — | ver |
| `evaluacion` (decisión de admisión) | ver/editar | ver | — | — |
| `matricula` | ver/editar | ver/editar | — | — |
| `cobros` | ver/editar | — | ver/editar | — |
| `comunicaciones` | ver/editar | ver/editar | ver/editar | — |
| `configuracion` (usuarios, roles, agenda) | ver/editar | — | ver | — |

Son los valores iniciales (tomados de la navegación y la matriz del mockup); Dirección los cambia y se aplican en segundos, sin volver a iniciar sesión.

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/roles` | configuracion.ver | Roles con sus permisos y nº de usuarios activos |
| GET | `/roles/matriz` | configuracion.ver | `{ roles: [...], modulos: [{ id, nombre, porRol: { SECRETARIA: { ver, editar } } }] }` |
| PATCH | `/roles/:codigo/modulos` | configuracion.editar | Un clic en la matriz: `{ modulo, ver, editar }` → devuelve la matriz |
| PUT | `/roles/:codigo/permisos` | configuracion.editar | `{ permisos: ["solicitudes.ver", …] }` (sustituye todos) |
| GET | `/roles/permisos` | configuracion.ver | Catálogo de módulos y permisos |

## Usuarios

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/usuarios?q=&rol=&estado=activos\|inactivos\|todos` | configuracion.ver | Lista |
| GET | `/usuarios/:id` | configuracion.ver | Detalle |
| POST | `/usuarios` | configuracion.editar | `{ email, nombre, roles: ["SECRETARIA"], password }` |
| PATCH | `/usuarios/:id` | configuracion.editar | `{ email?, nombre?, roles?, activo? }`. Al cambiar roles o desactivar se cierran sus sesiones. |
| POST | `/usuarios/:id/password` | configuracion.editar | `{ password }` (contraseña temporal; desbloquea la cuenta) |
| DELETE | `/usuarios/:id` | configuracion.editar | Lo borra; si tiene actividad registrada lo desactiva (`{ eliminado: false, desactivado: true }`) |
| GET | `/usuarios/responsables` | solicitudes.ver | Chips de responsable: usuarios activos que pueden gestionar solicitudes (`solicitudes.editar` según la matriz actual) |

Contraseña: mínimo 10 caracteres, con letras y números. Siempre debe quedar un usuario activo de Dirección (`ULTIMO_SUPERADMIN`).

## Público (sin login)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/public/vias` | Vía en dos niveles: `{ cursoEscolar, familias: [{ familia, etiqueta, etapa, cursos: [{ viaId, curso, nombre }] }] }` |
| POST | `/public/solicitudes` | Formulario "Albaydar Solicitud" → `201 { codigo }`. Envía el acuse. |
| GET / PATCH | `/public/solicitudes/completar/:token` | Ver y completar datos pendientes. Enlace de un solo uso. |
| GET | `/public/citas/:token` | Página "Albaydar Cita" |
| POST | `/public/citas/:token/elegir` | `{ huecoId }` (id de un `slot`) → confirma o cambia la fecha. Devuelve la cita completa (igual que el GET) más `cambio: boolean` |
| POST | `/public/citas/:token/otra-franja` | `{ franja?, prefiereLlamada }` → "Ninguna me encaja". Devuelve la cita completa (`estado: "alternativa"`) |
| POST | `/public/citas/:token/cancelar` | `{ motivo? }` → la familia cancela su cita confirmada. Devuelve la cita completa (`estado: "cancelada"`). Ver abajo |
| GET | `/public/citas/:token/ics` | "Añadir a mi calendario" |
| POST / DELETE | `/public/citas/:token/notas` | Boletín de notas: `multipart/form-data`, campo `archivo` (PDF, JPG, PNG o HEIC, máx. 10 MB) |

Cuerpo de `POST /public/solicitudes` (todos obligatorios salvo `modalidadInteres` y `asignadaSnec`):

```json
{
  "viaId": "uuid",
  "alumnaNombre": "Lucía", "alumnaApellidos": "Márquez Peña",
  "centroProcedencia": "IES Martínez Montañés",
  "modalidadInteres": "Ciencias",
  "tutorNombre": "Elena Peña Ríos", "email": "epena@correo.es", "telefono": "+34 622 418 903",
  "consentimientoPrivacidad": true,
  "asignadaSnec": false,
  "website": ""
}
```

- `asignadaSnec`: selector "Vía propia" (`false`, por defecto) / "Asignada por la Junta (SNEC)" (`true`).
- `website` es un campo trampa para bots: el formulario lo tiene oculto y vacío.

Respuesta de `GET /public/citas/:token` (mismos nombres que el `Component` del mockup):

```json
{
  "ref": "B-2026-0001", "alumno": "Lucía Márquez Peña", "tutor": "Elena", "curso": "Bachillerato 1º",
  "info": [{ "k": "Tipo", "v": "Presencial" }, { "k": "Con", "v": "Equipo directivo" },
           { "k": "Lugar", "v": "Sala de reuniones de Dirección · Avda. de la Palmera, 36" }],
  "estado": "propuesta | elegida | alternativa | caducada | cancelada",
  "duracion": 60,
  "slots": [{ "id": "uuid", "day": "Martes 27 de octubre", "time": "12:00 – 13:00", "inicio": "…", "fin": "…", "elegido": false, "disponible": true }],
  "elegida": null,
  "alternativa": null,
  "puedeCambiar": true,
  "puedeCancelar": false,
  "cambioHasta": null,
  "notas": null,
  "notasHasta": null
}
```

- Mientras la familia no elige, sus fechas están **reservadas**: `disponible: true`.
- Al elegir, las otras se liberan para otras familias. Si después quiere cambiar, puede volver a una de ellas solo si sigue libre.
- `cambioHasta` = 24 h después de la primera aceptación. Pasado ese momento `puedeCambiar: false` y `elegir` / `otra-franja` responden `CAMBIO_FUERA_DE_PLAZO`: el front debe ocultar "Cambiar la elección" y mostrar el teléfono de secretaría.

**Cancelar la cita** (acordado el 21/10/2026; el recordatorio del día antes lleva el enlace): `puedeCancelar` es `true` con la fecha elegida y hasta la hora de la cita, también pasadas las 24 h del cambio. `POST /public/citas/:token/cancelar { motivo? }`:

- Libera la hora, la solicitud vuelve a `EN_REVISION` para proponer otras fechas (evento `CITA_CANCELADA_FAMILIA`) y la propuesta queda `CANCELADA`.
- Secretaría recibe el aviso en la bandeja (`respuestas-familia`, tipo `CITA_CANCELADA_FAMILIA`) y por correo (`AVISO_CANCELACION_FAMILIA`, con el motivo). La familia recibe `CITA_CANCELADA` con la anulación (.ics).
- El enlace sigue abriendo la página con `estado: "cancelada"`, sin fechas disponibles y `puedeCambiar: false`: el front muestra «Has cancelado la cita; secretaría te escribirá con nuevas fechas». `elegir`, `otra-franja` y `cancelar` responden 409 `CITA_CANCELADA`.
- Sin fecha elegida, 409 `SIN_CITA_CONFIRMADA`; con la entrevista ya empezada, 410 `ENTREVISTA_PASADA`.

**Respuestas por correo:** todos los correos llevan `Reply-To` al buzón de secretaría (`MAIL_REPLY_TO` o, si no se indica, `MAIL_SECRETARIA`): si la familia responde para cancelar o cambiar, lo lee secretaría.

## Admisión

**Código de la solicitud** (acordado el 21/10/2026, formato provisional): letra de la vía, año y contador por letra y año: `B-2026-0001` (Bachillerato) y `C-2026-0001` (Ciclos). Las solicitudes creadas antes conservan su `SOL-2026-NNNN`. El formato está solo en `siguienteCodigo()` (`solicitudes/comun.ts`), para cambiarlo cuando el centro dé sus series.

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/solicitudes?vista=bandeja` | solicitudes.ver | Bandeja de admisión |
| GET | `/solicitudes?q=&familiaVia=&curso=&canal=&asignadaSnec=&responsableId=&estado=&columna=&notasPendientes=&familiaVinculada=&page=&pageSize=` | solicitudes.ver | Lista con filtros |
| GET | `/solicitudes/pipeline?porColumna=30&…` (mismos filtros) | solicitudes.ver | Kanban: `{ total, coinciden, columnas: [{ id, titulo, estados, total, items[] }] }` |
| GET | `/solicitudes/contadores` | solicitudes.ver | `{ bandeja, porEstado }` |
| GET | `/solicitudes/respuestas-familia` | solicitudes.ver | Aviso "la familia ya eligió fecha" (ver abajo) |
| POST | `/solicitudes/respuestas-familia/visto` | solicitudes.ver | `{ eventoIds: [...] }` → 204. No se vuelve a avisar a este usuario |
| POST | `/solicitudes` | solicitudes.editar | Alta interna (teléfono, presencial…): puede faltar el correo o el centro; la revisión lo marca |
| GET | `/solicitudes/:id` | solicitudes.ver | Ficha: `revision`, `siguientes`, `propuesta` vigente con sus franjas, `entrevista`, `documentos`, `correos`, `eventos`. La revisión se recalcula en cada lectura (las plazas libres cambian con otras solicitudes) |
| PATCH | `/solicitudes/:id` | solicitudes.editar | `{ responsableId?, observacionesInternas?, asignadaSnec?, canal? }` |
| POST | `/solicitudes/:id/revisar` | solicitudes.editar | Las cinco comprobaciones |
| POST | `/solicitudes/:id/pedir-completar` | solicitudes.editar | `{ campos?, mensaje? }` |
| POST | `/solicitudes/:id/citar` | solicitudes.editar | Ver abajo |
| POST | `/solicitudes/:id/entrevista-previa` | solicitudes.editar | «¿Ya tuvo entrevista? Sí»: ver [Entrevista previa](#entrevista-previa) |
| POST | `/solicitudes/:id/decision` | evaluacion.editar | "Registrar decisión y notificar" (ver [Evaluación y reserva](#evaluación-y-reserva-de-plaza)) |
| PATCH | `/solicitudes/:id/estado` | solicitudes.editar | Mover en el kanban; 409 `ACCION_REQUERIDA` si el destino exige una acción (`details.accion`). Las decisiones de admisión ya no se hacen aquí: responden `accion: "DECIDIR"` |
| GET | `/solicitudes/:id/documentos/:docId` | solicitudes.ver | Descarga del boletín |

### Cada solicitud en lista, bandeja y kanban

```json
{
  "id": "uuid", "codigo": "B-2026-0001",
  "estado": "CITACION_ENVIADA", "estadoEtiqueta": "Esperando a la familia", "estadoTono": "violet", "columna": "entrevista",
  "alumna": "Lucía Márquez Peña", "tutor": "Elena Peña Ríos", "email": "…", "telefono": "…",
  "centroProcedencia": "…", "modalidadInteres": "Ciencias",
  "via": { "familia": "BACHILLERATO", "curso": 1, "nombre": "1º Bachillerato", "etiqueta": "Bachillerato", "etapa": "Bachillerato" },
  "origen": "Solicitud web", "canal": "SOLICITUD_WEB", "asignadaSnec": false,
  "responsable": { "id": "uuid", "nombre": "María Reyes" },
  "revision": { "checks": [{ "id": "datos", "resultado": "ok", "texto": "Datos básicos completos" }], "completa": true, "faltan": [], "puedeCitar": true, "calculadaEn": "…" },
  "propuesta": {
    "id": "uuid", "estado": "PENDIENTE", "duracion": 60, "enviadaEn": "…", "respondidaEn": null, "reservadasHasta": "…",
    "alternativa": null,
    "fechas": [{ "id": "uuid", "inicio": "…", "fin": "…", "dia": "Lunes 2 de noviembre", "franja": "11:00 – 12:00", "estado": "RESERVADA" }]
  },
  "entrevista": null,
  "notasSubidas": false,
  "reserva": null,
  "posicionEspera": null,
  "siguientes": [
    { "estado": "DESCARTADA", "columna": null },
    { "estado": "PENDIENTE_COMPLETAR", "columna": "nueva", "accion": "PEDIR_QUE_COMPLETE" }
  ],
  "creadaEn": "…", "actualizadaEn": "…"
}
```

- `estadoTono` es una lista cerrada: `blue`, `amber`, `violet`, `orange`, `green`, `gray`, `red`.
- `revision`: las cinco comprobaciones, recalculadas en cada lectura. `resultado` es `ok`, `aviso` o `error`; `texto` se muestra tal cual.
- `propuesta`: la última no anulada, con sus fechas. `estado`: `PENDIENTE`, `CONFIRMADA`, `OTRA_FRANJA` (entonces trae `alternativa: { franja, prefiereLlamada }`) o `CADUCADA`.
- `entrevista`: `{ id, inicio, fin, dia, franja, estado, estadoEtiqueta, notas }` de la última no cancelada, o `null`. `notas` es la nota de la entrevista; también viene en la ficha.
- `notasSubidas`: la familia ha subido el boletín.
- `reserva`: la reserva de plaza vigente (ver [forma de la reserva](#evaluación-y-reserva-de-plaza)), o `null`.
- `posicionEspera`: puesto en la lista de espera de su vía (solo en `EN_ESPERA`), o `null`.
- `siguientes`: a qué estados puede **este usuario** mover la tarjeta. Si trae `accion`, no se mueve con `PATCH /estado`: el front abre ese panel.

  | `accion` | Panel |
  |---|---|
  | `PEDIR_QUE_COMPLETE` | "Pedir que complete" |
  | `CITAR_A_ENTREVISTA` | "Citar a entrevista" (solo si la solicitud está completa) |
  | `REGISTRAR_ENTREVISTA_PREVIA` | "Ya tuvo entrevista" (solo si la solicitud está completa y aún no tiene entrevista programada) |
  | `DECIDIR` | "Registrar decisión" (solo con `evaluacion.editar`) |
  | `REGISTRAR_COBRO` | "Registrar cobro" (de Admitida a Plaza reservada; solo con `cobros.editar` y si la reserva está pendiente o vencida) |

  `PATCH /estado` sigue validando (409 `ACCION_REQUERIDA` o `TRANSICION_NO_PERMITIDA`).

Filtros rápidos del kanban (solo se aplican con `=true`):

| Filtro | Qué devuelve |
|---|---|
| `notasPendientes=true` | "Entrevista sin notas": entrevista programada sin boletín |
| `familiaVinculada=true` | "Familia ya vinculada": la misma regla que la comprobación de la revisión (familia conocida, u otra solicitud con el mismo correo o teléfono; un correo vacío no cuenta) |
| `reservaPorVencer=true` | "Reserva por vencer": reserva pendiente a 3 días o menos del plazo, o vencida |
| `estado=EN_ESPERA` | "En lista de espera" |

`total` es el número de solicitudes del embudo sin filtros; `coinciden`, las que cumplen los filtros (suma de los `total` de las columnas).

### Aviso "la familia ya eligió fecha"

Al elegir fecha, la solicitud sale de la bandeja; al cancelarla, vuelve. `GET /solicitudes/respuestas-familia` devuelve las elecciones, cambios y cancelaciones de la familia de los últimos 7 días que **este usuario** aún no ha marcado como vistos (en `CITA_CANCELADA_FAMILIA`, `cita` es la que se canceló):

```json
{ "items": [{
  "eventoId": "uuid", "tipo": "CITA_CONFIRMADA | CITA_CAMBIADA | CITA_CANCELADA_FAMILIA", "fecha": "…",
  "solicitud": { "id": "uuid", "codigo": "B-2026-0001", "alumna": "Lucía Márquez Peña", "estado": "ENTREVISTA_PROGRAMADA" },
  "cita": { "inicio": "…", "fin": "…", "dia": "Martes 27 de octubre", "franja": "12:00 – 13:00" }
}] }
```

Tras mostrarlo, `POST /solicitudes/respuestas-familia/visto { eventoIds }`. Cada usuario tiene su propio "visto".

### Citar a entrevista

1. El panel pide la disponibilidad de la semana: `GET /agenda/disponibilidad?desde=2026-11-02&hasta=2026-11-06&duracion=60`
2. Secretaría marca de 1 a 3 horas y envía:

```json
POST /solicitudes/:id/citar
{ "inicios": ["2026-11-02T10:00:00.000Z", "2026-11-03T11:00:00.000Z"], "duracion": 60, "mensaje": null }
```

Respuesta `201`: `{ propuestaId, duracion, reservadasHasta, franjas: [{ id, inicio, fin, dia, franja, estado: "RESERVADA" }] }`.

Nunca el mismo día (acordado el 21/10/2026): la disponibilidad marca las horas de hoy con `motivo: "Mismo día"` y `citar` las rechaza con 400 `FECHA_MISMO_DIA`. Lo controla `permitirMismoDia` en la configuración de la agenda (por defecto `false`); la antelación mínima (`antelacionMinHoras`, 400 `FECHA_DEMASIADO_PRONTO`) se sigue aplicando.

Desde ese momento esas horas están bloqueadas para el resto. Si otra persona las acaba de coger: 409 `FRANJA_OCUPADA`. Volver a citar ("Cambiar la propuesta" / "Proponer nuevas fechas") anula la propuesta anterior, libera sus horas e invalida el enlace anterior.

### Entrevista previa

Paso 6 del diagrama, «¿Ya tuvo entrevista?»: si la alumna ya fue entrevistada fuera de la plataforma, no se repite.

```json
POST /solicitudes/:id/entrevista-previa
{ "fecha": "2026-10-20", "notas": "Entrevistada en las jornadas de puertas abiertas." }
```

- Desde Recibida, En revisión, Esperando a la familia o Pide otra franja (`ESTADOS_ENTREVISTA_PREVIA`), con la solicitud completa. Si había fechas propuestas, se anulan y se liberan, sin correo.
- Crea una entrevista `REALIZADA` ese día a las 12:00 con `lugar: "Entrevista previa (registrada sin cita)"`, que **no ocupa la agenda**, y la solicitud pasa a `ENTREVISTA_REALIZADA` (evento `ENTREVISTA_PREVIA`). En el calendario aparece en su día como realizada.
- Respuesta `201`: `{ estado, estadoEtiqueta, entrevista: { id, inicio, fin, dia, estado, lugar, notas } }`.
- Errores: 400 `FECHA_FUTURA` (si aún no se ha hecho, se cita), 409 `SOLICITUD_INCOMPLETA` (con `details.faltan`), 409 `ESTADO_NO_PERMITE` (con la entrevista ya programada se registra su resultado en Entrevistas).

## Agenda del equipo directivo

La disponibilidad no se crea a mano: es la **jornada** (por defecto lunes a viernes de 8:00 a 18:00) menos lo ocupado.

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/agenda/disponibilidad?desde&hasta&duracion` | entrevistas.ver o solicitudes.editar | `{ duracion, dias: [{ fecha, dia, libres, huecos: [{ inicio, fin, hora, franja, disponible, motivo }] }] }`. `motivo`: `Ocupado`, `Bloqueado`, `Pasado`, `Mismo día`, `No lectivo` |
| GET | `/agenda/ocupacion?desde&hasta` | ídem | Qué ocupa cada franja: reserva de propuesta (con la alumna), entrevista o bloqueo |
| POST | `/agenda/bloqueos` | entrevistas.editar | `{ fecha, inicio: "09:00", fin: "11:00", motivo }` (reunión, ausencia…) |
| DELETE | `/agenda/bloqueos/:id` | entrevistas.editar | Quitar un bloqueo |
| GET | `/agenda/configuracion` | entrevistas.ver | Horario actual |
| PUT | `/agenda/configuracion` | configuracion.editar | Ver abajo |

```json
{
  "diasSemana": [1, 2, 3, 4, 5],
  "horaInicio": "08:00", "horaFin": "18:00",
  "duraciones": [45, 60], "duracionPorDefecto": 45,
  "pasoMin": 30,
  "antelacionMinHoras": 2,
  "permitirMismoDia": false,
  "diasNoLectivos": ["2026-12-08"]
}
```

## Entrevistas

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/entrevistas?desde&hasta&familiaVia&curso&q&estado&incluirPendientes` | entrevistas.ver | Calendario y lista. `items` = confirmadas (con `notas` y `notasRecibidas`); `pendientes` = fechas reservadas esperando a la familia ("Sin confirmar · reservada") |
| PATCH | `/entrevistas/:id` | entrevistas.editar | `{ estado?: "REALIZADA" \| "NO_PRESENTADA", notas? }` |
| POST | `/entrevistas/:id/cancelar` | entrevistas.editar | `{ motivo?, notificar }`: libera la hora, envía la anulación con .ics y la solicitud vuelve a revisión |

## Evaluación y reserva de plaza

**Importes siempre en céntimos** (enteros): `30000` = 300,00 €. Cada importe viene también como texto (`importeTexto`: "300,00 €", con espacio de no separación antes de €).

### Registrar decisión y notificar

`POST /solicitudes/:id/decision` (`evaluacion.editar`):

```json
{ "decision": "ADMITIDA | EN_ESPERA | NO_ADMITIDA", "notificar": true, "motivo": "opcional, para la familia" }
```

| Decisión | Desde | Qué hace |
|---|---|---|
| `ADMITIDA` | Entrevista realizada, En espera | Crea la reserva (importe de la vía y plazo de `ajustes`). Con `notificar`, correo `ADMITIDA` con importe, IBAN, titular y fecha límite |
| `EN_ESPERA` | Entrevista realizada, Admitida, No admitida | Entra al final de la lista de su vía. Con `notificar`, correo con la posición y el motivo. Desde Admitida, anula la reserva pendiente (409 `RESERVA_CON_COBROS` si ya tiene cobros) |
| `NO_ADMITIDA` | Entrevista realizada, En espera | Con `notificar`, correo con el motivo |

Respuesta: `{ estado, estadoEtiqueta, reserva, posicionEspera, notificada }`. `notificada` es `false` si no se pidió, si la solicitud no tiene correo o si la plantilla está en borrador.

### Vista previa de la "Comunicación automática"

`POST /solicitudes/:id/decision/previsualizar` (`evaluacion.ver`), con `{ decision, motivo? }`. Devuelve el correo que recibiría la familia con **sus datos reales**: el importe de su vía, el IBAN configurado, la fecha límite si se decide hoy y la posición que tendría en la lista de espera. No cambia nada.

```json
{ "para": "familia@correo.es", "seEnviaria": true, "asunto": "Plaza admitida para …", "html": "<!doctype html>…", "texto": "…" }
```

- `seEnviaria: false` si la solicitud no tiene correo o la plantilla del evento está en borrador.
- Valida la transición igual que la decisión (409 `TRANSICION_NO_PERMITIDA`).

### Reserva

```json
{
  "id": "uuid", "estado": "PENDIENTE | PAGADA | VENCIDA | ANULADA", "estadoEtiqueta": "Pendiente de pago",
  "importe": 30000, "pagado": 10000, "pendiente": 20000, "importeTexto": "300,00 €", "pendienteTexto": "200,00 €",
  "fechaLimite": "2026-11-05", "fechaLimiteTexto": "jueves 5 de noviembre", "diasRestantes": 15,
  "recordatorioEnviadoEn": null, "creadaEn": "…", "pagadaEn": null
}
```

- `diasRestantes`: días naturales hasta la fecha límite; negativo si ya pasó; `null` si está pagada o anulada.
- Una sola reserva vigente por solicitud. Se anula sola al cambiar la decisión o al descartar una admitida (siempre que no tenga cobros).
- A 3 días del plazo sale un recordatorio a la familia (uno solo). Pasado el plazo queda `VENCIDA` y se avisa a secretaría y administración: **la plaza no se libera sola**, y si la familia paga tarde se registra igual.

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/reservas?estado=&porVencer=true&q=&page=&pageSize=` | cobros.ver o evaluacion.ver | "Control de reservas" y "Reservas por vencer". Cada ítem: la reserva + `solicitud { id, codigo, estado, alumna, tutor, email, telefono, via }`. Sin `estado`, todas menos las anuladas; ordenadas por fecha límite |
| POST | `/reservas/:id/recordar` | cobros.editar o solicitudes.editar | Botón "Recordar": envía ya `RECORDATORIO_PAGO` a la familia y devuelve la reserva con `recordatorioEnviadoEn` actualizado. Cuenta como el recordatorio de la reserva: el automático de 3 días ya no sale. 409 `RECORDATORIO_RECIENTE` si se envió otro hace menos de una hora; 409 `RESERVA_NO_PENDIENTE` si está pagada o anulada; 409 `RECORDATORIO_NO_ENVIADO` si no hay correo o la plantilla está en borrador |
| GET | `/reservas/configuracion` | configuracion.ver, cobros.ver o evaluacion.ver | Configuración (abajo) |
| PUT | `/reservas/configuracion` | configuracion.editar | Guardar configuración |

```json
{
  "importe": 30000,
  "importesPorVia": {},
  "iban": "ES9121000418450200051332",
  "titular": "Centro Educativo Albaydar",
  "plazoDias": 15,
  "metodos": ["TRANSFERENCIA", "EFECTIVO"]
}
```

La reserva acordada es de 300 € para todas las vías, así que `importesPorVia` va vacío. Solo hace falta si un día una vía tiene un importe de reserva distinto, por ejemplo `{ "CICLOS_PRIVADOS_GS": 25000 }`; la vía que no aparece usa `importe`. (No confundir con la cuota reglada de GS concertado, 180,30 €, que es de la matrícula, fase 04.) El IBAN se valida por sus dígitos de control.

Las solicitudes que se admitieron antes de existir la reserva (con el `PATCH /estado` antiguo) recibieron la suya con la migración `0004`: importe configurado y plazo de 15 días desde ese momento, sin correo. Para mandar a esas familias los datos de pago, usad "Recordar". El importe, el IBAN y el titular llegan a las plantillas como variables: no se escriben en el HTML.

## Cobros (registro manual)

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| POST | `/cobros` | cobros.editar | "Registrar cobro manual" |
| GET | `/cobros?solicitudId=&concepto=&metodo=&desde=&hasta=&incluirAnulados=&page=&pageSize=` | cobros.ver | Pestaña "Pagos". Devuelve también `suma` (de los no anulados, en céntimos) y `sumaTexto` |
| POST | `/cobros/:id/anular` | cobros.editar | `{ motivo }` (obligatorio). Un cobro nunca se borra |
| GET | `/cobros/resumen?desde=&hasta=` | cobros.ver | KPIs (abajo) |
| GET | `/cobros/:id/recibo` | cobros.ver | Recibo imprimible en HTML (`text/html`). El navegador lo imprime o lo guarda como PDF. Los anulados salen marcados «RECIBO ANULADO» |

`GET /cobros/resumen`:

```json
{
  "cobrado": 40000, "cobradoTexto": "400,00 €",
  "pendiente": 70000, "pendienteTexto": "700,00 €", "reservasPendientes": 3,
  "parcial": { "familias": 1, "cobrado": 10000, "pendiente": 20000, "cobradoTexto": "100,00 €", "pendienteTexto": "200,00 €" }
}
```

- `cobrado`: suma de los cobros no anulados. `desde` y `hasta` (fecha del pago) solo afectan a esta cifra.
- `pendiente`: lo que falta por cobrar de las reservas pendientes o vencidas (siempre el dato actual).
- `parcial`: reservas con algún pago pero sin completar. `familias` es el número de reservas en esa situación.

El recibo se pide con el token de sesión, así que el front lo descarga con `HttpClient` (`responseType: 'blob'`) y lo abre en una pestaña nueva.

Cuerpo de `POST /cobros`:

```json
{ "solicitudId": "uuid", "concepto": "RESERVA_PLAZA", "importe": 30000, "metodo": "TRANSFERENCIA | EFECTIVO", "fecha": "2026-10-21", "observaciones": null }
```

- `fecha` es el día del pago (por defecto, hoy; nunca futura). `concepto` de momento solo `RESERVA_PLAZA`.
- Cada cobro recibe un recibo de la serie R correlativo por año: `R-2026-0001`.
- Se admiten pagos parciales. No se puede cobrar más de lo pendiente (400 `IMPORTE_SUPERIOR_AL_PENDIENTE`, con `details.pendiente`).
- Cuando lo cobrado cubre la reserva, **en la misma operación** la reserva pasa a `PAGADA` y la solicitud a `PLAZA_RESERVADA`.
- Anular un cobro que deja la reserva sin cubrir la devuelve a `PENDIENTE` (o `VENCIDA` si el plazo pasó) y la solicitud vuelve a `ADMITIDA`.

Respuesta de registrar y anular: `{ cobro, reserva }`. Cada `cobro`:

```json
{
  "id": "uuid", "reciboNumero": "R-2026-0001", "fecha": "2026-10-21",
  "concepto": "RESERVA_PLAZA", "conceptoEtiqueta": "Reserva de plaza",
  "importe": 30000, "importeTexto": "300,00 €", "metodo": "TRANSFERENCIA", "metodoEtiqueta": "Transferencia",
  "observaciones": null, "registradoPor": { "id": "uuid", "nombre": "Administración" }, "registradoEn": "…",
  "anulado": null,
  "solicitudId": "uuid", "reservaId": "uuid"
}
```

`anulado`, si lo está: `{ en, motivo, por }`. En el listado cada cobro trae además `solicitud { id, codigo, alumna, via }`.

## Comunicaciones: plantillas de correo

Todos los correos salen de plantillas HTML editables, una **activada** por evento. El cuerpo es HTML con variables `{{alumna}}`; se envuelve automáticamente en el diseño común (logo, colores y pie del centro).

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/comunicaciones/eventos` | comunicaciones.ver | Eventos, cuándo se envían y sus variables (chips "Variables:") |
| GET | `/comunicaciones/plantillas` | comunicaciones.ver | Lista ("Plantillas por evento") |
| GET | `/comunicaciones/plantillas/:id` | comunicaciones.ver | Detalle |
| POST | `/comunicaciones/plantillas` | comunicaciones.editar | `{ evento, nombre, asunto, cuerpoHtml, estado }` |
| PATCH | `/comunicaciones/plantillas/:id` | comunicaciones.editar | "Guardar plantilla" (cualquier campo) |
| DELETE | `/comunicaciones/plantillas/:id` | comunicaciones.editar | Devuelve `aviso` si deja el evento sin plantilla activada |
| POST | `/comunicaciones/plantillas/previsualizar` | comunicaciones.ver | `{ evento, asunto, cuerpoHtml }` → `{ asunto, html, texto }` con datos de ejemplo (vista previa en vivo) |
| POST | `/comunicaciones/plantillas/:id/prueba` | comunicaciones.editar | "Enviar prueba" a tu correo (o `{ para }`) |
| GET | `/comunicaciones/envios?evento&estado&q&page` | comunicaciones.ver | "Histórico de envíos" |
| GET | `/comunicaciones/envios/resumen` | comunicaciones.ver | "Últimas 24 horas · 96,4 % de entrega" |
| POST | `/comunicaciones/envios/:id/reintentar` | comunicaciones.editar | Reintentar un envío con error |
| GET | `/comunicaciones/smtp/estado` | configuracion.ver | Comprueba la conexión con Gmail / el servidor de correo |

Reglas:
- Al **guardar**, el HTML se sanea: fuera `<script>`, `onclick` y enlaces `javascript:`. Si se usa una variable que no existe para el evento: 400 `VARIABLES_DESCONOCIDAS` (con la lista de las válidas).
- Activar una plantilla pasa a borrador la que estuviera activa para ese evento.
- En **borrador** no se envía. Excepción: los correos imprescindibles (llevan el enlace personal de la familia: pedir que complete, propuesta de fechas, confirmación y cambio de cita) se envían con la versión predeterminada si no hay ninguna activada, para no romper el flujo.

| Evento | Cuándo | Plantilla inicial |
|---|---|---|
| `SOLICITUD_RECIBIDA` | La familia envía el formulario | Activada |
| `COMPLETAR_SOLICITUD` | "Pedir que complete" | Activada · imprescindible |
| `CITACION_PROPUESTA` | "Citar a entrevista" | Activada · imprescindible |
| `CITACION_RECORDATORIO` | 3 días sin elegir fecha (uno solo) | Activada |
| `CITA_CONFIRMADA` | La familia elige fecha (con .ics) | Activada · imprescindible |
| `CITA_CAMBIADA` | Cambia la fecha dentro de las 24 h (con .ics) | Activada · imprescindible |
| `ENTREVISTA_RECORDATORIO` | El día antes | Activada |
| `CITA_CANCELADA` | Se anula la entrevista (con .ics de anulación) | Activada |
| `AVISO_OTRA_FRANJA` | "Ninguna me encaja" (a secretaría) | Activada |
| `AVISO_CANCELACION_FAMILIA` | La familia cancela su cita desde el enlace (a secretaría) | Activada |
| `ADMITIDA` | "Registrar decisión" → Admitida (importe, IBAN, fecha límite) | Activada |
| `EN_ESPERA` | "Registrar decisión" → En espera (posición) | Activada · texto provisional |
| `NO_ADMITIDA` | "Registrar decisión" → No admitida (motivo) | Activada · texto provisional |
| `RECORDATORIO_PAGO` | Reserva sin pagar a 3 días del plazo (uno solo) | Activada |
| `RESERVA_VENCIDA` | Pasa el plazo sin pagar (a secretaría y administración) | Activada |
| `MATRICULA_CONFIRMADA` | Fase 04 (texto del mockup) | Borrador |

Al arrancar, una plantilla de una fase que ya está construida y que sigue en borrador **sin haberse editado nunca** se sustituye por la predeterminada actual y se activa. Si el centro ya la ha tocado, no se cambia.

## Catálogo

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/catalogo/vias` | sesión | Vías con `ocupadas` y `libres` |
| POST / PATCH | `/catalogo/vias`, `/catalogo/vias/:id` | configuracion.editar | Alta y edición de vías y plazas |

## Rutas del front que enlazan los correos

Base `PUBLIC_APP_URL`. Deben existir en Angular y ser públicas:

- `/cita/:token` → página "Albaydar Cita"
- `/solicitud/completar/:token` → completar solicitud
- `/admision?ref=B-…` (o `C-…`) → solicitud en la bandeja (aviso interno a secretaría)
