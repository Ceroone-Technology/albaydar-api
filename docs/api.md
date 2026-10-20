# Contrato de la API para el front Angular

Base: `/api`. JSON en todas las respuestas. Fechas en ISO 8601 (UTC); la API ya devuelve también los textos formateados en hora de Madrid (`dia`, `franja`) tal como los muestran los mockups.

## Errores

Siempre con la misma forma, para un interceptor único en Angular:

```json
{ "error": { "code": "HUECO_NO_DISPONIBLE", "message": "Esa fecha acaba de ocuparse…", "details": {} } }
```

`message` está en español y se puede mostrar tal cual en el toast. `code` es estable para ramificar.

| HTTP | Cuándo | Códigos habituales |
|---|---|---|
| 400 | Datos inválidos | `DATOS_INVALIDOS` (con `details: [{campo, mensaje}]`), `HUECOS_INVALIDOS`, `TIPO_NO_PERMITIDO` |
| 401 | Sin sesión o caducada | `NO_AUTENTICADO`, `TOKEN_CADUCADO` → llamar a `/auth/refresh`, `CREDENCIALES_INVALIDAS`, `SESION_REVOCADA` |
| 403 | Rol sin permiso | `SIN_PERMISO` |
| 409 | Conflicto de negocio | `SOLICITUD_INCOMPLETA`, `HUECO_NO_DISPONIBLE`, `ACCION_REQUERIDA`, `ESTADO_CAMBIADO`, `CAMBIO_FUERA_DE_PLAZO` |
| 410 | Enlace público ya no vale | `PROPUESTA_SUSTITUIDA`, `ENLACE_CADUCADO`, `ENLACE_USADO` |
| 423 | Cuenta bloqueada 15 min | `CUENTA_BLOQUEADA` |
| 429 | Límite de peticiones | `DEMASIADAS_PETICIONES` |

## Autenticación

- **Access token** (JWT, 15 min) en memoria del front, nunca en `localStorage`. Se envía como `Authorization: Bearer …`.
- **Refresh token** en cookie `alb_rt` httpOnly, `path=/api/auth`. El front no la lee; solo llama con `withCredentials: true`.
- Rotación: cada `/refresh` emite cookie nueva. Si alguien reutiliza una antigua, se cierra la sesión entera (`SESION_REVOCADA`).
- 5 intentos fallidos → bloqueo de 15 minutos.

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | `{ accessToken, usuario: { id, email, nombre, roles[] } }` + cookie |
| POST | `/auth/refresh` | — (cookie) | igual que login |
| POST | `/auth/logout` | — | 204 |
| GET | `/auth/me` | — | `{ usuario }` |
| POST | `/auth/cambiar-password` | `{ actual, nueva }` | igual que login (cierra el resto de sesiones) |

**Al arrancar la app** Angular llama a `/auth/refresh`: si hay cookie válida, la sesión se recupera sin pedir contraseña.

**Interceptor recomendado:** si una petición devuelve 401 `TOKEN_CADUCADO`, llamar una sola vez a `/auth/refresh` (compartiendo la promesa entre peticiones simultáneas) y reintentar.

### Roles

`ADMIN` (pasa todos los controles), `SECRETARIA`, `DIRECCION`, `ADMINISTRACION`, `PROFESORADO`. Un usuario puede tener varios. En esta fase: leer requiere sesión; las acciones de admisión, agenda y entrevistas requieren `SECRETARIA` o `DIRECCION`; usuarios y vías, `ADMIN`. El selector de rol del mockup debe mostrar solo los roles que el usuario tiene.

## Público (sin login)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/public/vias` | Vía en dos niveles para el formulario: `{ cursoEscolar, familias: [{ familia, etiqueta, etapa, cursos: [{ viaId, curso, nombre }] }] }` |
| POST | `/public/solicitudes` | Formulario "Albaydar Solicitud" → `201 { codigo }`. Envía acuse a la familia. |
| GET | `/public/solicitudes/completar/:token` | Datos actuales y `camposPendientes` |
| PATCH | `/public/solicitudes/completar/:token` | La familia completa. El enlace es de un solo uso. |
| GET | `/public/citas/:token` | Página "Albaydar Cita" (ver forma abajo) |
| POST | `/public/citas/:token/elegir` | `{ huecoId }` → confirma o cambia la fecha |
| POST | `/public/citas/:token/otra-franja` | `{ franja?, prefiereLlamada }` → "Ninguna me encaja" |
| GET | `/public/citas/:token/ics` | "Añadir a mi calendario" (`entrevista-albaydar.ics`) |
| POST | `/public/citas/:token/notas` | `multipart/form-data`, campo `archivo` (PDF, JPG, PNG o HEIC, máx. 10 MB). Reemplaza el anterior. |
| DELETE | `/public/citas/:token/notas` | "Quitar" |

Cuerpo de `POST /public/solicitudes`:

```json
{
  "viaId": "uuid",
  "alumnaNombre": "Lucía", "alumnaApellidos": "Márquez Peña",
  "alumnaFechaNacimiento": "2011-03-14", "alumnaDni": null,
  "centroProcedencia": "IES Martínez Montañés", "cursoAnterior": "4º ESO",
  "modalidadInteres": "Ciencias",
  "tutorNombre": "Elena Peña Ríos", "email": "epena@correo.es", "telefono": "+34 622 418 903",
  "comentariosFamilia": null,
  "datosExtra": {},
  "consentimientoPrivacidad": true,
  "website": ""
}
```

`website` es un campo trampa para bots: el formulario lo tiene oculto y vacío. `datosExtra` recoge cualquier campo del formulario que aún no tenga columna (ver preguntas abiertas).

Respuesta de `GET /public/citas/:token` (mismo vocabulario que el `Component` del mockup):

```json
{
  "ref": "SOL-2026-0001", "alumno": "Lucía Márquez Peña", "tutor": "Elena", "curso": "Bachillerato 1º",
  "info": [{ "k": "Tipo", "v": "Presencial" }, { "k": "Con", "v": "Equipo directivo" },
           { "k": "Lugar", "v": "Sala de reuniones de Dirección · Avda. de la Palmera, 36" }],
  "estado": "propuesta | elegida | alternativa | caducada",
  "mensaje": null,
  "slots": [{ "id": "uuid", "dia": "Martes 1 de septiembre", "franja": "10:00 – 10:45",
              "inicio": "…", "fin": "…", "elegido": false, "disponible": true }],
  "elegida": null,
  "alternativa": null,
  "puedeCambiar": true,
  "notas": { "nombre": "boletin-notas.pdf", "tamano": 626688, "subidoEn": "…" },
  "notasHasta": "…"
}
```

`disponible: false` significa que otra familia acaba de quedarse ese hueco: píntalo deshabilitado. "Cambiar la elección" del mockup solo vuelve a la pantalla de elegir; el hueco anterior no se suelta hasta que la familia elige otro (así no pierde su cita si se arrepiente).

## Admisión (con login)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/solicitudes?vista=bandeja` | Bandeja de admisión |
| GET | `/solicitudes?columna=nueva&page=2&pageSize=50` | Más tarjetas de una columna del kanban |
| GET | `/solicitudes?q=…&familiaVia=BACHILLERATO&curso=1&canal=TELEFONO&asignadaSnec=true&responsableId=…&estado=…` | Lista con filtros (se pueden repetir `estado`, `familiaVia`, `canal`) |
| GET | `/solicitudes/pipeline?porColumna=30&q=…` | Kanban: `{ columnas: [{ id, titulo, total, items[] }] }` |
| GET | `/solicitudes/contadores` | `{ bandeja, porEstado }` para el badge del menú |
| POST | `/solicitudes` | Alta interna (teléfono, presencial, puertas abiertas, SNEC). Admite `canal`, `asignadaSnec`, `responsableId`. |
| GET | `/solicitudes/:id` | Ficha: datos, `revision`, `propuesta` vigente con huecos, `entrevista`, `documentos`, `correos` (trazabilidad) y `eventos` (historial) |
| PATCH | `/solicitudes/:id` | `{ responsableId?, observacionesInternas?, asignadaSnec?, canal? }` |
| POST | `/solicitudes/:id/revisar` | Recalcula y guarda las cinco comprobaciones; `RECIBIDA` → `EN_REVISION` |
| POST | `/solicitudes/:id/pedir-completar` | `{ campos?: string[], mensaje? }`. Sin `campos` usa los que faltan. Si ya estaba pendiente, es "Reenviar aviso". |
| POST | `/solicitudes/:id/citar` | `{ huecoIds: [1..3], mensaje? }`. Sustituye cualquier propuesta anterior ("Cambiar la propuesta" / "Proponer nuevas fechas"). |
| PATCH | `/solicitudes/:id/estado` | `{ estado, motivo? }`. Mover en el kanban. Si el destino exige una acción responde 409 `ACCION_REQUERIDA` con `details.accion` (`CITAR_A_ENTREVISTA`, `PEDIR_QUE_COMPLETE`…): el front abre ese panel. |
| GET | `/solicitudes/:id/documentos/:docId` | Descarga del boletín de notas |

Cada elemento de lista o tarjeta trae ya `estadoEtiqueta`, `estadoTono` (`blue`, `amber`, `violet`, `orange`, `green`, `gray`) y `columna`, para el badge de estado.

Forma de `revision` (lo que pinta el panel "Revisar"):

```json
{
  "checks": [
    { "id": "datos",   "resultado": "ok",    "texto": "Datos básicos completos" },
    { "id": "correo",  "resultado": "ok",    "texto": "Correo de contacto válido · por él se enviará la propuesta de fechas" },
    { "id": "plazas",  "resultado": "ok",    "texto": "1º Bachillerato: 6 plazas libres" },
    { "id": "familia", "resultado": "aviso", "texto": "Familia ya vinculada al centro · Hermana en 2º Bachillerato · Clara Márquez Peña" },
    { "id": "snec",    "resultado": "ok",    "texto": "Solicitud por vía propia" }
  ],
  "completa": true, "faltan": [], "puedeCitar": true
}
```

`resultado` → icono del mockup: `ok` = ✓ verde, `aviso` = "i" azul, `error` = "!" naranja. "Citar a entrevista" se deshabilita con `puedeCitar: false`.

## Agenda del equipo directivo

| Método | Ruta | Uso |
|---|---|---|
| GET | `/agenda/huecos?desde=2026-08-31&hasta=2026-09-04` | Rejilla del panel de citación. Cada hueco: `estado`, `seleccionable`, `enPropuestasPendientes`, `entrevista` |
| POST | `/agenda/huecos` | `{ fecha, inicio: "10:00", fin? }` (45 min por defecto) |
| POST | `/agenda/huecos/generar` | `{ desde, hasta, diasSemana?, franjas?, excluir? }`. Por defecto L–V a las 09:00, 10:00, 12:30 y 17:00. |
| PATCH | `/agenda/huecos/:id` | `{ estado: "BLOQUEADO" | "LIBRE" }` |
| DELETE | `/agenda/huecos/:id` | Solo si nunca se ha propuesto |

Los ocupados y bloqueados vienen con `seleccionable: false` (en el mockup, "Ocupado" en gris).

## Entrevistas

| Método | Ruta | Uso |
|---|---|---|
| GET | `/entrevistas?desde&hasta&familiaVia&curso&q&estado&incluirPendientes` | Calendario semanal y lista. `items` = entrevistas confirmadas; `pendientes` = huecos propuestos sin respuesta ("Sin confirmar"). |
| PATCH | `/entrevistas/:id` | `{ estado?: "REALIZADA" | "NO_PRESENTADA", notas? }`. Realizada → la solicitud pasa a "Evaluada". |
| POST | `/entrevistas/:id/cancelar` | `{ motivo?, notificar }`. Libera el hueco, envía anulación con .ics y la solicitud vuelve a revisión. |

## Usuarios y catálogo

| Método | Ruta | Uso |
|---|---|---|
| GET | `/usuarios?rol=SECRETARIA` | Chips de responsable |
| POST / PATCH | `/usuarios`, `/usuarios/:id` | Solo `ADMIN` |
| POST | `/usuarios/:id/password` | `ADMIN` fija contraseña temporal |
| GET | `/catalogo/vias` | Vías con `ocupadas` y `libres` |
| POST / PATCH | `/catalogo/vias`, `/catalogo/vias/:id` | Solo `ADMIN` |

## Rutas del front que enlazan los correos

Los correos llevan estos enlaces (base `PUBLIC_APP_URL`). Las rutas Angular deben existir y ser públicas:

- `/cita/:token` → página "Albaydar Cita"
- `/solicitud/completar/:token` → completar solicitud
- `/admision?ref=SOL-…` → bandeja (aviso interno a secretaría)
