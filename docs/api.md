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
| 400 | Datos inválidos | `DATOS_INVALIDOS` (con `details: [{campo, mensaje}]`), `FUERA_DE_HORARIO`, `DURACION_NO_VALIDA`, `VARIABLES_DESCONOCIDAS`, `ROL_DESCONOCIDO` |
| 401 | Sin sesión o caducada | `NO_AUTENTICADO`, `TOKEN_CADUCADO` → llamar a `/auth/refresh`, `CREDENCIALES_INVALIDAS`, `SESION_REVOCADA` |
| 403 | Falta el permiso | `SIN_PERMISO` |
| 409 | Conflicto de negocio | `SOLICITUD_INCOMPLETA`, `FRANJA_OCUPADA`, `HUECO_NO_DISPONIBLE`, `CAMBIO_FUERA_DE_PLAZO`, `ACCION_REQUERIDA`, `ULTIMO_SUPERADMIN` |
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
| GET | `/usuarios/responsables` | solicitudes.ver | Chips de responsable en la bandeja |

Contraseña: mínimo 10 caracteres, con letras y números. Siempre debe quedar un usuario activo de Dirección (`ULTIMO_SUPERADMIN`).

## Público (sin login)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/public/vias` | Vía en dos niveles: `{ cursoEscolar, familias: [{ familia, etiqueta, etapa, cursos: [{ viaId, curso, nombre }] }] }` |
| POST | `/public/solicitudes` | Formulario "Albaydar Solicitud" → `201 { codigo }`. Envía el acuse. |
| GET / PATCH | `/public/solicitudes/completar/:token` | Ver y completar datos pendientes. Enlace de un solo uso. |
| GET | `/public/citas/:token` | Página "Albaydar Cita" |
| POST | `/public/citas/:token/elegir` | `{ huecoId }` (id de un `slot`) → confirma o cambia la fecha |
| POST | `/public/citas/:token/otra-franja` | `{ franja?, prefiereLlamada }` → "Ninguna me encaja" |
| GET | `/public/citas/:token/ics` | "Añadir a mi calendario" |
| POST / DELETE | `/public/citas/:token/notas` | Boletín de notas: `multipart/form-data`, campo `archivo` (PDF, JPG, PNG o HEIC, máx. 10 MB) |

Cuerpo de `POST /public/solicitudes` (todos obligatorios salvo `modalidadInteres`):

```json
{
  "viaId": "uuid",
  "alumnaNombre": "Lucía", "alumnaApellidos": "Márquez Peña",
  "centroProcedencia": "IES Martínez Montañés",
  "modalidadInteres": "Ciencias",
  "tutorNombre": "Elena Peña Ríos", "email": "epena@correo.es", "telefono": "+34 622 418 903",
  "consentimientoPrivacidad": true,
  "website": ""
}
```

`website` es un campo trampa para bots: el formulario lo tiene oculto y vacío.

Respuesta de `GET /public/citas/:token` (mismos nombres que el `Component` del mockup):

```json
{
  "ref": "SOL-2026-0001", "alumno": "Lucía Márquez Peña", "tutor": "Elena", "curso": "Bachillerato 1º",
  "info": [{ "k": "Tipo", "v": "Presencial" }, { "k": "Con", "v": "Equipo directivo" },
           { "k": "Lugar", "v": "Sala de reuniones de Dirección · Avda. de la Palmera, 36" }],
  "estado": "propuesta | elegida | alternativa | caducada",
  "duracion": 60,
  "slots": [{ "id": "uuid", "day": "Martes 27 de octubre", "time": "12:00 – 13:00", "inicio": "…", "fin": "…", "elegido": false, "disponible": true }],
  "elegida": null,
  "alternativa": null,
  "puedeCambiar": true,
  "cambioHasta": null,
  "notas": null,
  "notasHasta": null
}
```

- Mientras la familia no elige, sus fechas están **reservadas**: `disponible: true`.
- Al elegir, las otras se liberan para otras familias. Si después quiere cambiar, puede volver a una de ellas solo si sigue libre.
- `cambioHasta` = 24 h después de la primera aceptación. Pasado ese momento `puedeCambiar: false` y `elegir` / `otra-franja` responden `CAMBIO_FUERA_DE_PLAZO`: el front debe ocultar "Cambiar la elección" y mostrar el teléfono de secretaría.

## Admisión

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/solicitudes?vista=bandeja` | solicitudes.ver | Bandeja de admisión |
| GET | `/solicitudes?q=&familiaVia=&curso=&canal=&asignadaSnec=&responsableId=&estado=&columna=&page=&pageSize=` | solicitudes.ver | Lista con filtros |
| GET | `/solicitudes/pipeline?porColumna=30` | solicitudes.ver | Kanban: `{ columnas: [{ id, titulo, total, items[] }] }` |
| GET | `/solicitudes/contadores` | solicitudes.ver | `{ bandeja, porEstado }` |
| POST | `/solicitudes` | solicitudes.editar | Alta interna (teléfono, presencial…): puede faltar el correo o el centro; la revisión lo marca |
| GET | `/solicitudes/:id` | solicitudes.ver | Ficha: `revision`, `propuesta` vigente con sus franjas, `entrevista`, `documentos`, `correos`, `eventos` |
| PATCH | `/solicitudes/:id` | solicitudes.editar | `{ responsableId?, observacionesInternas?, asignadaSnec?, canal? }` |
| POST | `/solicitudes/:id/revisar` | solicitudes.editar | Las cinco comprobaciones |
| POST | `/solicitudes/:id/pedir-completar` | solicitudes.editar | `{ campos?, mensaje? }` |
| POST | `/solicitudes/:id/citar` | solicitudes.editar | Ver abajo |
| PATCH | `/solicitudes/:id/estado` | solicitudes.editar (+ evaluacion.editar para ADMITIDA / NO_ADMITIDA / EN_ESPERA) | Mover en el kanban; 409 `ACCION_REQUERIDA` si el destino exige una acción |
| GET | `/solicitudes/:id/documentos/:docId` | solicitudes.ver | Descarga del boletín |

### Citar a entrevista

1. El panel pide la disponibilidad de la semana: `GET /agenda/disponibilidad?desde=2026-11-02&hasta=2026-11-06&duracion=60`
2. Secretaría marca de 1 a 3 horas y envía:

```json
POST /solicitudes/:id/citar
{ "inicios": ["2026-11-02T10:00:00.000Z", "2026-11-03T11:00:00.000Z"], "duracion": 60, "mensaje": null }
```

Respuesta `201`: `{ propuestaId, duracion, reservadasHasta, franjas: [{ id, inicio, fin, dia, franja, estado: "RESERVADA" }] }`.

Desde ese momento esas horas están bloqueadas para el resto. Si otra persona las acaba de coger: 409 `FRANJA_OCUPADA`. Volver a citar ("Cambiar la propuesta" / "Proponer nuevas fechas") anula la propuesta anterior, libera sus horas e invalida el enlace anterior.

## Agenda del equipo directivo

La disponibilidad no se crea a mano: es la **jornada** (por defecto lunes a viernes de 8:00 a 18:00) menos lo ocupado.

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/agenda/disponibilidad?desde&hasta&duracion` | entrevistas.ver o solicitudes.editar | `{ duracion, dias: [{ fecha, dia, libres, huecos: [{ inicio, fin, hora, franja, disponible, motivo }] }] }`. `motivo`: `Ocupado`, `Bloqueado`, `Pasado`, `No lectivo` |
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
  "diasNoLectivos": ["2026-12-08"]
}
```

## Entrevistas

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/entrevistas?desde&hasta&familiaVia&curso&q&estado&incluirPendientes` | entrevistas.ver | Calendario y lista. `items` = confirmadas; `pendientes` = fechas reservadas esperando a la familia ("Sin confirmar · reservada") |
| PATCH | `/entrevistas/:id` | entrevistas.editar | `{ estado?: "REALIZADA" \| "NO_PRESENTADA", notas? }` |
| POST | `/entrevistas/:id/cancelar` | entrevistas.editar | `{ motivo?, notificar }`: libera la hora, envía la anulación con .ics y la solicitud vuelve a revisión |

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
| `ADMITIDA`, `RECORDATORIO_PAGO`, `MATRICULA_CONFIRMADA` | Fases siguientes (textos del mockup) | Borrador |

## Catálogo

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/catalogo/vias` | sesión | Vías con `ocupadas` y `libres` |
| POST / PATCH | `/catalogo/vias`, `/catalogo/vias/:id` | configuracion.editar | Alta y edición de vías y plazas |

## Rutas del front que enlazan los correos

Base `PUBLIC_APP_URL`. Deben existir en Angular y ser públicas:

- `/cita/:token` → página "Albaydar Cita"
- `/solicitud/completar/:token` → completar solicitud
- `/admision?ref=SOL-…` → solicitud en la bandeja (aviso interno a secretaría)
