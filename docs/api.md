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
- Además, por IP: 20 intentos **fallidos** cada 15 minutos → 429 `DEMASIADAS_PETICIONES`. Los correctos no cuentan (en el centro todo el personal comparte IP). En producción, `TRUST_PROXY=true` para que la API vea la IP real.

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
  "tutorNombre": "Elena Peña Ríos", "email": "epena@example.com", "telefono": "+34 622 418 903",
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
  "estado": "propuesta | elegida | realizada | no_presentada | alternativa | caducada | cancelada",
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
- Con la entrevista ya registrada, el estado es `realizada` (se celebró) o `no_presentada` (la familia no vino), con `puedeCambiar` y `puedeCancelar` a `false`: el front deja de decir «Te esperamos».
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
| `familiaVinculada=true` | "Familia ya vinculada": la misma regla que la comprobación de la revisión (familia conocida, una alumna del centro que no esté de baja con un contacto con ese correo o teléfono, u otra solicitud con el mismo correo o teléfono; un correo vacío no cuenta, y la alumna que nació de esa misma solicitud tampoco) |
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
| GET | `/agenda/configuracion` | entrevistas.ver, solicitudes.editar o configuracion.ver | Horario actual |
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
| GET | `/entrevistas?desde&hasta&familiaVia&curso&q&estado&incluirPendientes` | entrevistas.ver | Calendario y lista. `items` = confirmadas (con `notas`, `notasRecibidas`, `ficha`, `familiaVia` y `cursoNumero`); `pendientes` = fechas reservadas esperando a la familia ("Sin confirmar · reservada") |
| PATCH | `/entrevistas/:id` | entrevistas.editar | `{ estado?: "REALIZADA" \| "NO_PRESENTADA", notas?, ficha? }` (ver «Ficha de la entrevista») |
| POST | `/entrevistas/:id/cancelar` | entrevistas.editar | `{ motivo?, notificar }`: libera la hora, envía la anulación con .ics y la solicitud vuelve a revisión |

### Ficha de la entrevista

La parte «Entrevista» y «Datos a rellenar por el centro» de la solicitud en papel de Bachillerato. Viaja como `ficha` en `PATCH /entrevistas/:id` y vuelve en la entrevista (`GET /entrevistas › items[].ficha`, `solicitud.entrevista.ficha` en listas, bandeja, kanban y `GET /solicitudes/:id`); `null` si nunca se rellenó. Las **observaciones** de la ficha son `notas`.

```json
{
  "otroCentro": true, "otroCentroNombre": "IES Murillo",
  "motivoEleccion": "Por el ambiente y la cercanía",
  "haRepetido": false, "repeticionDetalle": null,
  "notaMedia": 8.46,
  "modalidad": "HUMANIDADES_CCSS | CIENCIAS_TECNOLOGIA",
  "optativa": "LATIN | MATEMATICAS | BIOLOGIA | DIBUJO_TECNICO",
  "boletinEntregado": true, "fechaEntregaNotas": "2026-11-04",
  "valoracion": "FAVORABLE | CON_RESERVAS | DESFAVORABLE",
  "valoracionComentario": "opcional",
  "entrevistados": ["PADRE", "MADRE", "ALUMNA"],
  "realizadaPor": "Rosa Jurado"
}
```

- **Parcial:** lo que no llega se conserva; `null` borra el dato. Campos desconocidos → 400.
- **Coherencia** (400 `DATOS_INVALIDOS` con `details`): optativa de su modalidad (Humanidades y CC. SS.: Latín o Matemáticas; Ciencias y Tecnología: Biología o Dibujo Técnico; en 2º, «Latín II»); modalidad y optativa solo en Bachillerato; `fechaEntregaNotas` no futura; `notaMedia` de 0 a 10, redondeada a 2 decimales.
- **Realizada** (acordado el 05/11/2026): `estado: "REALIZADA"` exige `valoracion` y al menos un `entrevistados`; si falta, 400 `FICHA_INCOMPLETA` con `details.faltan` (`["valoracion", "entrevistados"]`) y no cambia nada. Una vez realizada, editar la ficha no puede vaciar esos dos. Las realizadas antes de la ficha pueden seguir editando solo `notas`.
- `boletinEntregado` es el boletín entregado en mano; el subido por la familia ya consta como `notasRecibidas` / `notasSubidas`.

## Evaluación y reserva de plaza

**Importes siempre en céntimos** (enteros): `30000` = 300,00 €. Cada importe viene también como texto (`importeTexto`: "300,00 €", con espacio de no separación antes de €).

### Registrar decisión y notificar

`POST /solicitudes/:id/decision` (`evaluacion.editar`):

```json
{ "decision": "ADMITIDA | EN_ESPERA | NO_ADMITIDA", "notificar": true, "motivo": "opcional, para la familia", "fechaLimite": "AAAA-MM-DD, opcional, solo ADMITIDA" }
```

| Decisión | Desde | Qué hace |
|---|---|---|
| `ADMITIDA` | Entrevista realizada, En espera | Crea la reserva (importe de la vía y plazo de `ajustes`). Con `notificar`, correo `ADMITIDA` con importe, IBAN, titular y fecha límite |
| `EN_ESPERA` | Entrevista realizada, Admitida, No admitida | Entra al final de la lista de su vía. Con `notificar`, correo con la posición y el motivo. Desde Admitida, anula la reserva pendiente (409 `RESERVA_CON_COBROS` si ya tiene cobros) |
| `NO_ADMITIDA` | Entrevista realizada, En espera | Con `notificar`, correo con el motivo |

Respuesta: `{ estado, estadoEtiqueta, reserva, posicionEspera, notificada }`. `notificada` es `false` si no se pidió, si la solicitud no tiene correo o si la plantilla está en borrador.

### Vista previa de la "Comunicación automática"

`fechaLimite` (05/11/2026): acorta el plazo de la reserva si quedan pocas plazas. Va de mañana al plazo general (`ajustes.reserva.plazoDias`); fuera de ese rango, 400 `FECHA_LIMITE_FUERA_DE_PLAZO` sin cambiar nada. Sin ella, el plazo general. El correo dice los días naturales que da esa fecha.

`POST /solicitudes/:id/decision/previsualizar` (`evaluacion.ver`), con `{ decision, motivo?, fechaLimite? }`. Devuelve el correo que recibiría la familia con **sus datos reales**: el importe de su vía, el IBAN configurado, la fecha límite si se decide hoy y la posición que tendría en la lista de espera. No cambia nada.

```json
{ "para": "familia@example.com", "seEnviaria": true, "asunto": "Plaza admitida para …", "html": "<!doctype html>…", "texto": "…" }
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
| PATCH | `/reservas/:id/plazo` | evaluacion.editar o cobros.editar | «Cambiar plazo» de una reserva pendiente o vencida: `{ fechaLimite, motivo?, notificar = true }`. Acortar (pocas plazas) o ampliar (fuerza mayor): de hoy a 90 días. Una vencida vuelve a `PENDIENTE`. Queda en el historial (`PLAZO_RESERVA_CAMBIADO` con `antes`, `despues` y `motivo`). Con `notificar`, la familia recibe `RECORDATORIO_PAGO` con la nueva fecha; si esta cae a 3 días o menos, cuenta como el recordatorio y el automático no repite; si no, el automático vuelve a salir 3 días antes. Devuelve la reserva y `notificada`. 400 `FECHA_LIMITE_PASADA`, `FECHA_LIMITE_FUERA_DE_PLAZO` o `MISMA_FECHA_LIMITE`; 409 `RESERVA_NO_PENDIENTE` si está pagada o anulada |
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
| POST | `/cobros` | cobros.editar | "Registrar cobro manual": `{ solicitudId, importe, metodo, fecha?, observaciones?, notificar = true }`. Con `notificar`, la familia recibe `PAGO_RECIBIDO` con el recibo; la respuesta trae `notificado` |
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

## Alumnado

Expedientes, familias e histórico de interacciones (pantalla Alumnado del mockup).

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/alumnado?q=&familia=&curso=&cursoEscolar=&estado=&promociona=&page=&pageSize=` | alumnado.ver | Listado ordenado por apellidos. `q` busca en nombre y apellidos (también «Apellidos, Nombre»), DNI/NIE y expediente, sin importar tildes ni mayúsculas. `pageSize` por defecto 25, máximo 200 |
| GET | `/alumnado/exportar` (mismos filtros) | alumnado.ver | CSV (ver Exportaciones) |
| GET | `/alumnado/:id` | alumnado.ver | Ficha con contactos e `historial` |
| POST | `/alumnado` | alumnado.editar | Alta manual (201, devuelve la ficha) |
| PATCH | `/alumnado/:id` | alumnado.editar | Editar datos, contactos o estado. Devuelve la ficha |
| POST | `/alumnado/:id/baja` | alumnado.editar | `{ motivo, fecha? }` (fecha por defecto hoy, nunca futura). 409 `YA_DE_BAJA` |
| POST | `/alumnado/:id/notas` | alumnado.editar | `{ texto }`: nota interna en el historial (201, devuelve la ficha) |

**Estados** (textos y tonos del mockup):

| `estado` | `estadoEtiqueta` | `estadoTono` | Cuándo |
|---|---|---|---|
| `RESERVA` | Reserva confirmada | blue | Al pagar la reserva de plaza |
| `EN_PROCESO` | En proceso | amber | Matrícula en curso (también el alumnado que asigna la Junta) |
| `MATRICULADA` | Matriculada | green | Alumna del centro |
| `BAJA` | Baja | gray | Con `baja: { fecha, motivo }` |

La matrícula digital mueve el estado sola: abrirla pasa el expediente a «En proceso» y exportarla a Séneca, a «Matriculada». Secretaría también puede cambiarlo con `PATCH { estado }` (`RESERVA`, `EN_PROCESO` o `MATRICULADA`). En una baja, ese mismo PATCH la reactiva. La baja va por su propia ruta, porque exige motivo.

**De dónde sale un expediente** (`origen`):
- `ADMISION`: lo crea solo el cobro que completa la reserva, en la misma operación. Lleva el nombre, la vía y la modalidad de la solicitud, y el tutor como contacto principal (parentesco «Madre, padre o tutor»). DNI, nacimiento y domicilio quedan vacíos: la solicitud no los recoge. Si se anula ese cobro, el expediente se borra si nadie lo ha tocado; si tiene notas o cambios, pasa a baja con el motivo «Reserva anulada…», y vuelve a «Reserva confirmada» si se paga otra vez.
- `MANUAL`: `POST /alumnado`.
- `SENECA`: reservado para la importación de Séneca (aún no existe).

Cuerpo del alta (`POST /alumnado`):

```json
{
  "nombre": "Julia", "apellidos": "Herrera Cifuentes", "documento": "49218735T", "fechaNacimiento": "2010-06-02",
  "email": null, "telefono": null, "domicilio": "C/ Feria 12, 41003 Sevilla",
  "familia": "BACHILLERATO", "curso": 1, "cursoEscolar": "2026-2027", "estudios": "Ciencias y Tecnología",
  "estado": "MATRICULADA", "promociona": null,
  "contactos": [
    { "parentesco": "Madre", "nombre": "Lucía Cifuentes Mora", "telefono": "+34 699 100 200", "email": "lcifuentes@example.com", "principal": true }
  ]
}
```

- **Obligatorios:** nombre, apellidos, `documento`, `fechaNacimiento`, `familia`, `curso` (1 o 2), `cursoEscolar` (`2026-2027`) y `estado`.
- **`documento`:** DNI o NIE con su letra de control. Se guarda normalizado (`49.218.735-t` → `49218735T`). Es único: si ya existe, 409 `DOCUMENTO_DUPLICADO` con `details.expediente` del que lo tiene.
- **Contactos:**
  - como mucho 6, y cada uno con parentesco, nombre y teléfono;
  - el correo es opcional (`''` cuenta como vacío) y se guarda en minúsculas;
  - como mucho uno `principal` (si no, 400 `VARIOS_CONTACTOS_PRINCIPALES`); si no se marca ninguno, lo es el primero.
- **Expediente:** `EXP-AAAA-NNNN` (formato del mockup), correlativo por año de alta. Lo pone la API.

`PATCH /alumnado/:id`: los mismos campos, todos opcionales. `null` borra un dato opcional. `contactos`, si llega, sustituye la lista entera. Un campo desconocido (p. ej. `expediente`) da 400.

Cada expediente (listado y ficha):

```json
{
  "id": "uuid", "expediente": "EXP-2026-0001",
  "nombre": "Clara", "apellidos": "Márquez Peña", "nombreCompleto": "Clara Márquez Peña",
  "documento": "49218734E", "email": null, "telefono": null, "fechaNacimiento": "2009-04-12", "domicilio": "C/ Asunción 18, 41011 Sevilla",
  "familia": "BACHILLERATO", "familiaEtiqueta": "Bachillerato", "etapa": "Bachillerato",
  "curso": 2, "cursoEtiqueta": "Bachillerato 2º", "cursoEscolar": "2026-2027", "estudios": "Ciencias y Tecnología",
  "estado": "MATRICULADA", "estadoEtiqueta": "Matriculada", "estadoTono": "green",
  "origen": "MANUAL", "origenEtiqueta": "Alta manual", "promociona": null,
  "fechaAlta": "2026-09-01", "baja": null, "solicitud": null,
  "contactos": [{ "id": "uuid", "parentesco": "Madre", "nombre": "Elena Peña Ríos", "telefono": "+34 622 418 903", "email": "epena@example.com", "principal": true }],
  "creadaEn": "…", "actualizadaEn": "…"
}
```

- `contactos` viene con el principal primero.
- `solicitud`: `{ id, codigo }` de la solicitud de origen, si la hay.
- `promociona`: la renovación 1º → 2º (`null` = sin decidir).

La ficha añade `historial`, del más reciente al más antiguo:

```json
{ "id": "…", "fecha": "…", "tipo": "REGISTRO | CORREO | ENTREVISTA | COBRO | NOTA", "titulo": "Reserva de plaza · 300,00 €", "descripcion": "Recibo R-2026-0003 · Transferencia · pagado el 05/11/2026", "autor": "Administración" }
```

- `REGISTRO`: alta, cambios de datos («Cambia: domicilio, contactos de la familia», nunca los valores), cambios de estado, bajas y reactivaciones, y «Solicitud recibida».
- `CORREO`: los correos a la familia de la solicitud de origen, con el asunto y el destinatario.
- `ENTREVISTA`: fecha, lugar, valoración de la ficha y observaciones.
- `COBRO`: concepto, importe, recibo y forma de pago, también los anulados.
- `NOTA`: notas internas.

La ficha añade también `matriculas`: `[{ id, codigo, cursoEscolar, curso, estado, estadoEtiqueta }]`, la más reciente primero.

## Matrícula digital

Fase 04, entregas 1 a 3 en la API (08 y 10/11/2026):
- apertura y renovación 1º → 2º;
- borrador con versión, páginas leídas y enlaces de la familia;
- documentos rellenados con huella, firmas y mandatos SEPA;
- archivos, envío con los PDF firmados, devolución a borrador y exportación a Séneca.

Falta el front (entrega 4). Diseño completo en `docs/matricula.md`.

**Estados:**

```
BORRADOR ──enviar──▶ ENVIADA ──exportar a Séneca──▶ EXPORTADA
    ▲                   │
    └────devolver───────┘   (secretaría, con motivo)
```

### Secretaría

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/matriculas?q=&estado=&cursoEscolar=&familia=&curso=&page=&pageSize=` | matricula.ver | Listado, lo último guardado primero. `q` busca en nombre, apellidos y expediente de la alumna y en el código de la matrícula, sin importar tildes |
| POST | `/matriculas` | matricula.editar | `{ alumnaId, enviarEnlace? }`: abre la matrícula (201) |
| POST | `/matriculas/renovacion` | matricula.editar | `{ familia, cursoEscolar, alumnaIds?, enviarEnlace? }`: abre en bloque la de 2º |
| GET | `/matriculas/:id` | matricula.ver | Ficha con `enlaces` e `historial` |
| PUT | `/matriculas/:id` | matricula.editar | `{ borrador, version }`: guarda el borrador |
| POST | `/matriculas/:id/paginas-leidas` | matricula.editar | `{ paginas: ["lopd-1", …] }` (Modo firma con la familia delante) |
| GET | `/matriculas/:id/documentos/:doc` | matricula.ver | Documento rellenado con su huella (ver «Documentos y firmas») |
| POST | `/matriculas/:id/firmas/:hueco` | matricula.editar | `{ imagen, huella }`: firma en secretaría con la familia delante (201, devuelve la ficha) |
| DELETE | `/matriculas/:id/firmas/:hueco` | matricula.editar | «Borrar» la firma (se anula con motivo). Devuelve la ficha |
| POST | `/matriculas/:id/archivos/:destino` | matricula.editar | Sube la foto o un documento (multipart, campo `archivo`). 201, devuelve la ficha |
| DELETE | `/matriculas/:id/archivos/:destino` | matricula.editar | Quita el archivo. Devuelve la ficha |
| GET | `/matriculas/:id/archivos/:destino` | matricula.ver | Descarga el archivo |
| POST | `/matriculas/:id/enviar` | matricula.editar | `{ version }`: envía la matrícula (secretaría con la familia) |
| POST | `/matriculas/:id/devolver` | matricula.editar | `{ motivo, avisar? }`: vuelve a borrador una enviada |
| GET | `/matriculas/:id/pdf/:doc` | matricula.ver | PDF final de un documento firmado |
| POST | `/matriculas/:id/exportar-seneca` | matricula.editar | Fichero de Séneca de una matrícula (CSV) |
| POST | `/matriculas/exportar-seneca` | matricula.editar | `{ matriculaIds }`: fichero de Séneca de varias (CSV) |
| GET | `/matriculas/configuracion` | matricula.ver o configuracion.ver | Acreedores SEPA |
| PUT | `/matriculas/configuracion` | configuracion.editar | Guarda los acreedores SEPA |
| POST | `/matriculas/:id/enlaces` | matricula.editar | `{ alcance, progenitor?, enviar?, email? }`: enlace nuevo (201) |
| DELETE | `/matriculas/:id/enlaces/:enlaceId` | matricula.editar | Anula un enlace. Devuelve la ficha |

**Abrir** (`POST /matriculas`) depende del estado del expediente:

| Expediente | Matrícula |
|---|---|
| «Reserva confirmada» o «En proceso» (admisión, alta manual, Séneca) | Su curso escolar y curso, alumna nueva. El expediente pasa a «En proceso» |
| «Matriculada» en 1º | **Renovación:** 2º del curso escolar siguiente, alumna que continúa (sin ideario ni LOPD). Se precarga con su matrícula de 1º. El expediente sigue «Matriculada» |

- **Errores:** 409 `MATRICULA_YA_EXISTE` (una por alumna y curso escolar), `ALUMNA_DE_BAJA`, `SIN_CURSO_SIGUIENTE` (ya está en 2º) y `NO_PROMOCIONA` (`promociona: false` en el expediente; `null` sí se abre).
- **Enlace:** siempre se crea el enlace de la familia. Con `enviarEnlace` (por defecto `true`) se envía `MATRICULA_ENLACE` al primer contacto con correo, empezando por el principal.
- **Respuesta:** `{ matricula, enlace: { id, alcance, progenitor, url, enviadoA, expiraEn } }`. `url` solo se devuelve aquí (en la BD queda el hash del token): secretaría la puede copiar si la familia no tiene correo. `enviadoA` es `null` si no se envió.
- **Borrador inicial (alumnado nuevo):**
  - del expediente: nombre, apellidos (con dos palabras exactas se separan en primer y segundo apellido; si no, todo va al primero), DNI, nacimiento (`dd/mm/aaaa`), correo, teléfono y domicilio, vía y curso;
  - los dos primeros contactos pasan a ser la madre o tutora y el padre o tutor;
  - de la solicitud: el centro de procedencia;
  - `annex.minor`, por la fecha de nacimiento si la hay.
- **Borrador de la renovación:** copia el de 1º, con curso `2`, la modalidad de 1º como `previousModality`, materias vacías, Albaydar como curso anterior y la promoción del expediente. Se vacían las becas, los documentos en papel, las páginas leídas y la declaración. Se conservan la familia y la cuenta.

**Renovación en bloque** (`POST /matriculas/renovacion`):
- **A quién incluye:** alumnas «Matriculada» de 1º de esa `familia` y `cursoEscolar` (el que termina) con `promociona: true`. Con `alumnaIds`, solo esas, sin mirar `promociona`.
- **Transacciones:** cada alumna va en la suya, así que una que falle no frena al resto.
- **Respuesta:** `{ creadas: [{ alumnaId, expediente, matriculaId, codigo, enlaceEnviadoA }], omitidas: [{ alumnaId, expediente, motivo }] }`.

**Cada matrícula** (ficha de secretaría):

```json
{
  "id": "uuid", "codigo": "M-2027-0001", "estado": "BORRADOR", "estadoEtiqueta": "Borrador",
  "cursoEscolar": "2027-2028", "familia": "BACHILLERATO", "curso": 1, "cursoEtiqueta": "Bachillerato 1º", "nuevaAlumna": true,
  "version": 3,
  "alumna": { "id": "uuid", "expediente": "EXP-2026-0008", "nombreCompleto": "Carmen Márquez Peña" },
  "solicitud": { "id": "uuid", "codigo": "B-2026-0006" },
  "borrador": { "via": "bach", "course": "1", "newStudent": null, "student": { … }, "…": "…", "photo": null, "documents": {}, "signatures": {}, "readPages": { "lopd-1": true } },
  "pendientes": { "student": ["student.birthDate"], "ideario": ["signature.ideario", "lopd.dop", "signature.lopd"] },
  "puedeEnviar": false,
  "documentos": { "done": 1, "total": 6 },
  "firmas": [{ "hueco": "sepa-titular", "documento": "sepa", "estado": "VALIDA | DESACTUALIZADA | ANULADA", "firmadaEn": "…", "motivo": "Cambió: Número de cuenta · IBAN", "enlace": { "alcance": "FAMILIA", "progenitor": null }, "enSecretaria": false }],
  "mandatos": [{ "referencia": "M-2027-0001-SEPA1", "tipo": "SEPA", "secuencia": "RCUR", "esquema": "CORE", "acreedor": { "identificador": "ES09000G41829037", "nombre": "Albaydar" }, "iban": "ES9121000418450200051332", "bic": null, "titular": "Elena Peña Ríos", "titularDocumento": "12345678Z", "fechaFirma": "2027-06-12", "estado": "VIGENTE", "anulado": null }],
  "guardado": { "en": "…", "por": "familia | secretaria", "nombre": "María Reyes" },
  "enviadaEn": null, "exportadaEn": null, "devuelta": null,
  "creadaEn": "…", "actualizadaEn": "…",
  "enlaces": [{ "id": "uuid", "alcance": "FAMILIA", "progenitor": null, "enviadoA": "familia@example.com", "expiraEn": "…", "revocadoEn": null, "ultimoUsoEn": "…", "creadoEn": "…", "activo": true }],
  "historial": [{ "id": "uuid", "tipo": "CREADA | ENLACE | ENLACE_ANULADO | EDITADA", "texto": "Cambia: datos de la alumna, familia", "fecha": "…", "autor": "Familia" }]
}
```

- **`borrador`:** tiene **la forma exacta de `EnrollmentDraft` del front**, con sus nombres en inglés. Las reglas de la API son una copia de `enrollment.rules.ts` (`src/modules/matricula/reglas.ts`).
  - `photo`, `documents` y `signatures` los pone el servidor:
    - `signatures` trae solo las firmas que **valen**, como `{ "sepa-titular": { "signedAt": "…" } }`, sin la imagen (va con el documento);
    - `photo` y `documents` (`{ "m4": { … } }`) traen los archivos subidos, como `{ "name": "dni.pdf", "size": 48211, "uploadedAt": "…" }`.
- **`pdfs`:** los PDF finales vigentes, `[{ documento, tamano, sha256, creadoEn }]` (vacío hasta enviar).
  - `readPages` sale de las páginas leídas guardadas.
- **`pendientes`:** lo que falta en cada paso del flujo, con la vía como primer paso (`stepMissing`). Solo trae los pasos incompletos, y vacío significa que se puede enviar (`puedeEnviar`).
- **`documentos`:** el progreso del checklist (`checklistProgress`).
- **Listado:** cada fila trae lo mismo sin `borrador`, `pendientes`, `enlaces` ni `historial`, y con `alumna: { id, expediente, nombreCompleto }`.
- **`historial`:** la familia y cada usuario de secretaría tienen **un evento `EDITADA` por sesión de trabajo** (15 min), con las partes tocadas y nunca los valores. Así el autoguardado no llena el historial.

### Guardar el borrador y la versión

`PUT /matriculas/:id` (secretaría) y `PUT /public/matricula/:token` (familia) reciben `{ borrador, version }`.

- **`borrador`:** completo, como lo tiene el front. Se aceptan `photo`, `documents` y `signatures`, pero se ignoran.
- **Validación:** objetos estrictos. Un campo desconocido, un valor fuera de catálogo (`via: "eso"`) o un texto demasiado largo dan 400 con su ruta. Los textos no se validan al guardar (el borrador se guarda a medias): lo obligatorio está en `pendientes`.
- **Versión:**
  - `version` tiene que ser la actual. Si otro guardó antes: 409 `VERSION_ANTIGUA`, con `details: { version, guardadoPor: "familia" | "secretaria", guardadoPorNombre, guardadoEn }` y un `message` listo para el aviso («La familia ha cambiado esta matrícula mientras la tenías abierta. Recarga para ver sus cambios.»).
  - El front detiene el autoguardado y ofrece recargar; no mezcla nada.
  - Toda respuesta trae la `version` nueva. Un guardado **sin cambios no sube la versión**, así que el autoguardado puede repetir.
- **Lo que la familia no cambia:** desde el enlace, la API conserva la vía, el curso, `newStudent` y `manualChecks` (los documentos en papel), aunque lleguen cambiados. Eso lo decide secretaría.
- **Matrícula ya enviada o exportada:**
  - la familia recibe 409 `MATRICULA_ENVIADA` en cuanto la matrícula deja de ser borrador;
  - secretaría puede seguir editando una `ENVIADA`; una `EXPORTADA`, ya no (409 `MATRICULA_EXPORTADA`).

**Páginas leídas** (Modo firma):
- **Hora:** cuando una página pasa a leída, se guarda con la hora del servidor. Nunca se quitan; un `false` no las borra.
- **Páginas válidas:** solo cuentan las que existen (`impreso-1`, `lopd-1`…`lopd-7`…). El resto se ignora, y una clave mal formada da 400.
- **Dos vías:**
  - en el `PUT`, dentro de `borrador.readPages`;
  - con `POST …/paginas-leidas { paginas }`, que **no sube la versión**. Así un progenitor puede leer mientras la familia rellena, sin conflictos.

### Enlaces de la familia

- **Alcance `FAMILIA`:** todo el asistente. Es el que se crea al abrir la matrícula.
- **Alcance `PROGENITOR`:** con `progenitor: "padre" | "madre"`. El borrador le llega en solo lectura (`soloLectura: true`): puede marcar páginas leídas y, cuando existan las firmas, firmar sus huecos de la LOPD. Si se envía, el correo (`MATRICULA_ENLACE_PROGENITOR`) es obligatorio.
- **Enlace nuevo:** sustituye al anterior del mismo alcance y progenitor. El anterior responde 410 `ENLACE_SUSTITUIDO`.
- **Envío:**
  - con `enviar: false` solo se crea, y la `url` de la respuesta se puede copiar;
  - con `enviar` y sin `email`, el de `FAMILIA` va al contacto principal (400 `SIN_CORREO` si no hay ninguno).
- **Cuándo se puede crear:** solo con la matrícula en `BORRADOR`.
- **Caducidad:** el 30 de septiembre del curso de la matrícula (a las 23:59 de Madrid), y nunca antes de 30 días desde que se crea. Caducado, 410 `ENLACE_CADUCADO`. Un token que no existe es 404 `ENLACE_NO_VALIDO`.

### Familia (sin login)

| Método | Ruta | Límite (por enlace) | Uso |
|---|---|---|---|
| GET | `/public/matricula/:token` | 600 cada 15 min | La matrícula |
| PUT | `/public/matricula/:token` | 900 cada 15 min | `{ borrador, version }` |
| POST | `/public/matricula/:token/paginas-leidas` | 900 cada 15 min | `{ paginas }` |
| GET | `/public/matricula/:token/documentos/:doc` | 600 cada 15 min | Documento rellenado con su huella |
| POST | `/public/matricula/:token/firmas/:hueco` | 60 por hora | `{ imagen, huella }` (201) |
| DELETE | `/public/matricula/:token/firmas/:hueco` | 60 por hora | «Borrar» la firma |
| POST | `/public/matricula/:token/archivos/:destino` | 30 por hora | Sube la foto o un documento (multipart, campo `archivo`), 201 |
| DELETE | `/public/matricula/:token/archivos/:destino` | 30 por hora | Quita el archivo |
| POST | `/public/matricula/:token/enviar` | 900 cada 15 min | `{ version }`: envía la matrícula |
| GET | `/public/matricula/:token/pdf/:doc` | 600 cada 15 min | Copia en PDF de un documento firmado |

- **Límites:** cuentan por enlace (el hash del token), no por IP, porque una red de colegio o de casa comparte IP. Los tokens inexistentes o caducados (404/410) cuentan aparte, por IP: 120 cada 15 min. Pasado el límite: 429 `DEMASIADAS_PETICIONES`.
- **Cabeceras:** `Cache-Control: no-store` y `Referrer-Policy: no-referrer`, como el resto de enlaces.
- **Respuesta:** la misma ficha sin `enlaces` ni `historial`, con `alumna: { nombreCompleto }`, `solicitud: { codigo }`, `enlace: { alcance, progenitor, expiraEn }` y `soloLectura` (enviada, exportada o enlace de progenitor). En `mandatos`, el IBAN va enmascarado (`ES91 **** **** **** **** 1332`) y sin el DNI del titular.

### Documentos y firmas

Los cinco documentos (`impreso`, `ideario`, `lopd`, `sepa`, `plus`) los da la API, rellenados con los datos de la matrícula: el lector del front pinta lo que recibe y deja de usar sus propios textos. Los textos legales están en `src/modules/matricula/documentos/textos.ts`, versionados (`lopd@2026-1`); no se editan desde Comunicaciones.

**`GET …/documentos/:doc`:**

```json
{
  "id": "lopd", "version": "lopd@2026-1", "nombre": "Autorización LOPD, cesión de datos y otros", "nota": "Seis firmas · páginas 4, 5 y 6",
  "membrete": { "nombre": "CENTRO EDUCATIVO ALBAYDAR", "direccion": "Avda. de la Palmera, 36 · 41012 Sevilla · T 954 61 02 54" },
  "huella": "64 caracteres hexadecimales (SHA-256)",
  "paginas": [
    {
      "numero": 4,
      "bloques": [
        { "tipo": "titulo", "texto": "AUTORIZACIONES · continuación" },
        { "tipo": "casillas", "opciones": [{ "etiqueta": "Atención médica · datos de salud", "texto": "…", "marcada": true, "estado": "Autoriza", "campo": "lopd.authorizations.a9" }] }
      ],
      "firma": {
        "titulo": "Firma de las autorizaciones", "aviso": "Ambas firmas son obligatorias", "declaracion": "He leído el documento completo y lo firmo.",
        "huecos": [{ "id": "lopd-padre", "etiqueta": "FIRMA DEL PADRE / TUTOR", "subtitulo": null }, { "id": "lopd-madre", "etiqueta": "FIRMA DE LA MADRE / TUTORA", "subtitulo": null }]
      }
    }
  ],
  "paginasLeidas": ["lopd-1", "lopd-2"],
  "puedeFirmar": false,
  "firmas": { "lopd-madre": { "firmadaEn": "…", "imagen": "data:image/png;base64,…" } }
}
```

- **Bloques:**
  - `titulo`, `subtitulo`, `parrafo` y `nota`, con `texto`;
  - `campos` (`titulo`, y cada campo con `etiqueta`, `valor`, `campo?` y `ancho?`);
  - `casillas` (opciones múltiples);
  - `opcion` (una sola: la DOP o la modalidad de pago, con `campo`, `aviso` y opciones con `valor`);
  - `tabla` (`filas: [{ clave, valor }]`);
  - `fecha`, con su `plantilla` y su `texto`.
- **Lo que se corrige desde el documento:** un campo o una casilla con `campo` se puede corregir desde el propio documento. `campo` es la ruta del borrador (`economic.sepa.iban`, `lopd.authorizations.a12`, `lopd.dop`…). El front cambia el borrador, lo guarda (`PUT`) y vuelve a pedir el documento, porque su huella cambia.
- **Fecha:** es la de la primera firma válida del documento o, sin firmar, la de hoy (en hora de Madrid). **No entra en la huella:** la prueba de cuándo se firmó es la hora de la firma.
- **Firmas:** `firmas` trae solo las que valen de ese documento, con la imagen.
- **Disponibilidad:** un documento que no forma parte de la matrícula responde 404 `DOCUMENTO_NO_APLICA` (p. ej. AlbaydarPLUS en Bachillerato). Un enlace de progenitor solo puede ver la LOPD (403 `ENLACE_SIN_PERMISO`).

**Huella:** SHA-256 del documento en JSON canónico (claves ordenadas): el id, la versión del texto y todo lo que se ve, salvo el texto de la fecha. Cualquier dato que salga en el documento la cambia; un dato que no sale, no.

**Firmar** (`POST …/firmas/:hueco`, `{ imagen, huella }`):
- **`imagen`:** PNG en data URL (se comprueba la firma de bytes), de 200 KB como máximo. La ruta tiene su propio límite de cuerpo (300 KB), no el general de 200 KB.
- **`huella`:** la del documento que se está viendo.
- **Comprobaciones, en orden:**
  1. la matrícula está en `BORRADOR` (409 `MATRICULA_ENVIADA`);
  2. con un enlace de progenitor, el hueco es suyo (403 `ENLACE_SIN_PERMISO`): el padre firma `lopd-padre`, `lopd-img-padre` y `lopd-pd-padre`;
  3. la imagen es válida (400 `FIRMA_NO_VALIDA`);
  4. el documento forma parte de la matrícula (409 `DOCUMENTO_NO_APLICA`);
  5. está leído entero (409 `DOCUMENTO_SIN_LEER`, con `details.faltan: ["lopd-3", …]`);
  6. la LOPD tiene la DOP elegida y la orden SEPA, la modalidad de pago (409 `FALTAN_DATOS`);
  7. en la orden SEPA y la de AlbaydarPLUS, la cuenta se puede domiciliar (400 `DATOS_CUENTA_NO_VALIDOS`, con `details.errores`): titular escrito, DNI/NIE del titular con su letra, IBAN de un país SEPA con sus dígitos de control y BIC con formato válido si se escribe;
  8. la huella coincide con la del documento actual (409 `DOCUMENTO_CAMBIADO`, con `details.huella`): el front vuelve a cargar el documento.
- **Qué guarda:**
  - el hueco, el documento y su versión, y la huella;
  - el documento tal como se firmó (uno por huella);
  - la fecha y hora del servidor, la IP y el navegador;
  - el enlace con el que firmó (nunca el token) o el usuario de secretaría;
  - la imagen y su SHA-256.
- **Volver a firmar un hueco:** la firma anterior se anula con el motivo «Firmada de nuevo».
- **Respuesta:** la ficha (secretaría) o la vista pública (familia).

**Una firma vale mientras su huella coincida** con la del documento actual.
- **En borrador**, se comprueba en cada lectura:
  - una firma cuyo documento cambió sale como `DESACTUALIZADA`, con el motivo en palabras del documento («Cambió: Número de cuenta · IBAN»). También pasa si cambian los acreedores de la configuración;
  - al guardar el borrador, esas firmas se **anulan** (`ANULADA`; nunca se borran), con su mandato si lo tenían, y queda en el historial «Hay que volver a firmar «Orden de domiciliación…». Cambió: …»;
  - si un documento deja de hacer falta (p. ej. la matrícula pasa a «alumna que continúa»), sus firmas se anulan con el motivo «El documento ya no hace falta en esta matrícula».
- **Ya enviada**, valen las firmas vigentes. Si secretaría cambia un dato que sale en un documento firmado, al guardar también se anulan.
- **Lo que ven las reglas:** solo las firmas que valen cuentan para `pendientes`, `puedeEnviar` y `documentos`.
- **`firmas`** (en la ficha) trae la última firma de cada hueco con su estado y su motivo, para mostrar «Hay que volver a firmar: cambió …».

**Borrar** (`DELETE …/firmas/:hueco`): anula la firma vigente con el motivo «Borrada» (404 `FIRMA_NO_ENCONTRADA` si no hay).

**Historial:** `FIRMADA` («Orden de domiciliación de adeudo directo SEPA · firma del titular · mandato M-2027-0001-SEPA1»), `FIRMA_ANULADA` y `FIRMA_BORRADA`.

### Mandatos SEPA

Al firmar la orden SEPA (`sepa-titular`) o la de AlbaydarPLUS (`plus-titular`) nace su mandato:
- **Referencia:** `{código de la matrícula}-{SEPA|PLUS}{n}`. Es única y nunca se reutiliza: si se vuelve a firmar porque cambió la cuenta, la modalidad o el titular, el mandato anterior queda `ANULADO` y nace `…SEPA2`.
- **Secuencia:** `RCUR` para mensualidades y para AlbaydarPLUS (el primer cargo de la remesa irá como `FRST`); `OOFF` para el pago único, como la cuota reglada de GS concertado. Esquema `CORE`.
- **Datos que guarda:** el acreedor del momento (identificador y nombre), IBAN y BIC normalizados, titular, su DNI/NIE y el día de la firma.
- **Dónde se ve completo:** el IBAN y el DNI del titular, solo en la ficha de secretaría. En la vista de la familia, el IBAN va enmascarado.

### Configuración: acreedores SEPA

`GET/PUT /matriculas/configuracion` (guarda en `ajustes.matricula`):

```json
{
  "acreedores": [
    { "id": "general", "nombre": "Albaydar", "direccion": "Avd. La Palmera 36 · 41012 Sevilla · España", "identificador": "ES09000G41829037" },
    { "id": "gs-concertado", "nombre": "Albaydar", "direccion": "Avd. La Palmera 36 · 41012 Sevilla · España", "identificador": "ES09605G41829037" }
  ],
  "acreedorPorFamilia": { "BACHILLERATO": "general", "CICLOS_CONCERTADOS_GM": "general", "CICLOS_CONCERTADOS_GS": "gs-concertado", "CICLOS_PRIVADOS_GS": "general" },
  "acreedorPlus": "general"
}
```

- **Validación:** el identificador cumple la norma AT-02 (país, dígitos de control calculados sobre el NIF, sufijo de 3 caracteres y NIF). Los `id` referenciados tienen que existir.
- **Valores provisionales:** el de GS concertado es una suposición pendiente del centro (pregunta 24).

### Archivos de la familia

`destino`: `photo` (foto de carné, que cuenta para «2 fotos tamaño carné», `m5`), `m4` (fotocopia del DNI), `c2` (tarjeta de la Seguridad Social), `b1` (Libro de Familia) o `b2` (certificación académica).
- **Solo los que pide la matrícula:** según el checklist de las reglas. Si no hace falta, 409 `DOCUMENTO_NO_APLICA`; por ejemplo, el Libro de Familia en GM.
- **Tipo real del fichero:** PDF, JPG, PNG o HEIC; la foto, solo imagen. Si no, 400 `TIPO_NO_PERMITIDO`. Hasta `UPLOAD_MAX_MB` (10 MB).
- **Uno por destino:** subir otro lo sustituye; el anterior se marca eliminado y sale del almacén. Quitar: 404 `ARCHIVO_NO_ENCONTRADO` si no había.
- **Cuándo:** solo en `BORRADOR`. El enlace de un progenitor no sube archivos (403 `ENLACE_SIN_PERMISO`).
- **Historial:** «Sube: …», «Sustituye: …» y «Quita: …».
- **Conservación:** cada archivo guarda su categoría (`FOTO` o `COPIA_DOCUMENTO`). Los plazos están pendientes del centro (pregunta 25): nada se borra solo.

### Enviar

`POST …/enviar { version }`, desde el enlace de la familia o desde secretaría:
- **Comprobaciones, en orden:**
  1. la matrícula está en `BORRADOR` (409 `MATRICULA_ENVIADA`);
  2. no es un enlace de progenitor (403);
  3. `version` es la actual (409 `VERSION_ANTIGUA`): se envía exactamente lo que se ve;
  4. está **completa**, con las mismas reglas que el front (`canSubmit`): datos, firmas que valen y archivos. Si no, 409 `MATRICULA_INCOMPLETA`, con `details.pendientes`.
- **Qué hace, en la misma transacción:**
  - genera el **PDF final** de cada documento firmado;
  - pasa la matrícula a `ENVIADA`;
  - envía `MATRICULA_RECIBIDA` a la familia, con los PDF adjuntos;
  - si envió la familia, avisa a secretaría (`AVISO_MATRICULA_ENVIADA`, con el enlace a la matrícula).
- **Después:** la familia ya no edita, ni firma, ni sube archivos (409 `MATRICULA_ENVIADA`). Su vista queda en `soloLectura`.

**PDF final** (`GET …/pdf/:doc`; `application/pdf`, `no-store`):
- **Contenido:** el documento **tal como se firmó** (el guardado al firmar, no el borrador de ahora), con los trazos y la fecha y hora de cada firma.
- **Hoja de evidencias:**
  - el documento y la versión de su texto, la matrícula, la alumna y la huella;
  - la frase de lectura («Páginas 1 a 7 marcadas como leídas en el navegador (primera marca …; última …)»);
  - por cada firma: hueco, fecha y hora del servidor, origen (enlace de la familia o del progenitor con su id, o secretaría con el nombre de quien estaba), IP, navegador y SHA-256 del trazo.
- **Dónde se guarda:** en el almacén, con su SHA-256.
- **Antes de enviar:** 404 `PDF_NO_DISPONIBLE`.
- **Progenitor:** con su enlace, solo descarga la LOPD.

### Devolver a borrador

`POST /matriculas/:id/devolver { motivo, avisar }`:
- **Desde qué estado:** solo desde `ENVIADA`. Con `EXPORTADA`, 409 `MATRICULA_EXPORTADA`; con `BORRADOR`, `MATRICULA_NO_ENVIADA`.
- **Qué hace:**
  - la matrícula vuelve a `BORRADOR` con `devuelta: { en, motivo }`;
  - los PDF dejan de valer (al volver a enviarla se generan otros);
  - con `avisar` (por defecto, `true`), la familia recibe `MATRICULA_DEVUELTA` con el motivo.
- **Las firmas siguen valiendo** mientras sus documentos no cambien.

### Exportar a Séneca

`POST /matriculas/:id/exportar-seneca` o `POST /matriculas/exportar-seneca { matriculaIds }` (hasta 300). Responde con el CSV (`seneca-M-2027-0001-AAAA-MM-DD.csv` o `seneca-matriculas-…`), con el mismo formato que las demás exportaciones.
- **Requisitos:** las matrículas tienen que estar enviadas (409 `MATRICULA_NO_ENVIADA`, con `details.codigos`) y seguir completas. Si secretaría cambió un dato firmado, 409 `MATRICULA_INCOMPLETA`: hay que devolverla.
- **Todo o nada:** si una no se puede exportar, no se exporta ninguna.
- **La primera vez**, cada matrícula:
  - pasa a `EXPORTADA`;
  - deja la **alumna «Matriculada»** con la vía, el curso y el curso escolar de la matrícula;
  - pasa la **solicitud** de origen a `MATRICULADA`, si estaba en «Plaza reservada»;
  - envía `MATRICULA_CONFIRMADA` a la familia.
- **Volver a exportar** una ya exportada solo genera otra vez el fichero, y queda en el historial (`SENECA`).
- **Una exportada** ya no se edita ni se devuelve (409 `MATRICULA_EXPORTADA`).
- **Columnas:** provisionales hasta tener el formato oficial (pregunta 28). Están todas en `src/modules/matricula/seneca.ts`: matrícula, expediente, curso escolar, enseñanza, curso, ciclo, modalidad y materias, alumna nueva, apellidos, nombre, nacimiento, sexo, documento, NUSS, lugar y país de nacimiento, contacto y domicilio, centro anterior, los dos tutores, familia numerosa y PASEN.

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
| `PAGO_RECIBIDO` | Se registra un cobro de la reserva: importe, recibo y si la plaza queda reservada o cuánto falta (`{{situacion}}`) | Activada |
| `RESERVA_VENCIDA` | Pasa el plazo sin pagar (a secretaría y administración) | Activada |
| `MATRICULA_ENLACE` | Se abre la matrícula o se envía un enlace nuevo a la familia | Activada · imprescindible |
| `MATRICULA_ENLACE_PROGENITOR` | Enlace al otro progenitor para que firme | Activada · imprescindible |
| `MATRICULA_RECIBIDA` | Se envía la matrícula: los documentos firmados en PDF, adjuntos | Activada |
| `AVISO_MATRICULA_ENVIADA` | La familia envía la matrícula (a secretaría) | Activada |
| `MATRICULA_DEVUELTA` | Secretaría devuelve una matrícula enviada, con el motivo | Activada |
| `MATRICULA_CONFIRMADA` | Exportada a Séneca (texto del mockup, sin la frase de los adjuntos: pregunta 33) | Activada |

Al arrancar, una plantilla de una fase que ya está construida y que sigue en borrador **sin haberse editado nunca** se sustituye por la predeterminada actual y se activa. Si el centro ya la ha tocado, no se cambia.

## Exportaciones (CSV para Excel)

Cada listado tiene su descarga con **los mismos filtros y permisos**, sin paginar (`page` y `pageSize` se ignoran; tope de 10 000 filas). Responden `text/csv; charset=utf-8` con `Content-Disposition: attachment; filename="<nombre>-AAAA-MM-DD.csv"` (expuesta por CORS) y `Cache-Control: no-store`.

| Ruta | Permiso | Filtros | Columnas |
|---|---|---|---|
| `GET /solicitudes/exportar` | solicitudes.ver | los de `GET /solicitudes` (`vista`, `columna`, `estado`, `familiaVia`, `q`…) | datos de la solicitud y del tutor, comprobaciones pendientes, entrevista con su ficha, lista de espera y reserva |
| `GET /entrevistas/exportar` | entrevistas.ver | los de `GET /entrevistas` (`desde` y `hasta` obligatorios); sin las fechas sin confirmar | cita, familia, boletín y la ficha completa con observaciones |
| `GET /reservas/exportar` | cobros.ver o evaluacion.ver | los de `GET /reservas` (`porVencer`, `estado`, `q`) | alumna, familia, estado, fechas, importe, pagado y pendiente |
| `GET /cobros/exportar` | cobros.ver | los de `GET /cobros` (`desde`, `hasta`, `metodo`, `incluirAnulados`…) | recibo, fecha, alumna, concepto, forma de pago, importe (los anulados en su propia columna), anulación y quién lo registró |
| `GET /alumnado/exportar` | alumnado.ver | los de `GET /alumnado` (`q`, `familia`, `curso`, `cursoEscolar`, `estado`, `promociona`) | expediente, alumna, DNI/NIE, nacimiento, etapa, curso, estudios, estado, promoción, contacto principal, datos de la alumna, origen, solicitud, alta y baja |

Formato pensado para abrir con doble clic en Excel en español: separador `;`, coma decimal, BOM UTF-8, CRLF, fechas `dd/mm/aaaa` (y hora de Madrid), importes en euros sin símbolo y Sí/No. Una celda que empieza por `= + - @` lleva un apóstrofo delante (inyección de fórmulas); los teléfonos `+34 …`, un espacio. Cada exportación queda en el log (usuario, tipo, filas y nombres de los filtros, sin sus valores).

## Catálogo

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/catalogo/vias` | sesión | Vías con `ocupadas` y `libres` |
| POST / PATCH | `/catalogo/vias`, `/catalogo/vias/:id` | configuracion.editar | Alta y edición de vías y plazas |

## Rutas del front que enlazan los correos

Base `PUBLIC_APP_URL`. Deben existir en Angular y ser públicas:

- `/cita/:token` → página "Albaydar Cita"
- `/solicitud/completar/:token` → completar solicitud
- `/matricula/:token` → asistente de matrícula de la familia (pendiente en el front)
- `/enrollments/:id` → matrícula en la plataforma (aviso a secretaría)
- `/admision?ref=B-…` (o `C-…`) → solicitud en la bandeja (aviso interno a secretaría)
