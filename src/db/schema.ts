// ─────────────────────────────────────────────────────────────────────────────
//  Albaydar · Esquema de base de datos (PostgreSQL + Drizzle ORM)
//
//  Alcance de esta fase: autenticación + primera parte del flujo de admisión
//  (captación pública → revisión → pedir que complete → citación → entrevista).
//  Matrícula, cobros, evaluación y comunicaciones quedan para fases siguientes.
//
//  Cambios en este archivo → `npm run db:generate` crea la migración SQL en
//  /drizzle, que se versiona en git y se aplica con `npm run db:migrate`.
// ─────────────────────────────────────────────────────────────────────────────
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const creado = () => ts('created_at').notNull().defaultNow();
const actualizado = () =>
  ts('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ── Enumerados ──────────────────────────────────────────────────────────────

export const familiaViaEnum = pgEnum('familia_via', [
  'BACHILLERATO',
  'CICLOS_CONCERTADOS_GM',
  'CICLOS_CONCERTADOS_GS',
  'CICLOS_PRIVADOS_GS',
]);

export const estadoSolicitudEnum = pgEnum('estado_solicitud', [
  'RECIBIDA', //               entra desde el formulario público
  'EN_REVISION', //            secretaría la revisa
  'PENDIENTE_COMPLETAR', //    se pidió a la familia que complete datos
  'CITACION_ENVIADA', //       huecos propuestos; la familia aún no elige
  'OTRA_FRANJA_SOLICITADA', // la familia pidió otra franja
  'ENTREVISTA_PROGRAMADA', //  la familia confirmó un hueco
  'ENTREVISTA_REALIZADA', //   pendiente de decisión
  'EN_ESPERA', //              lista de espera (correo automático de seguimiento)
  'ADMITIDA', //               → correo con datos bancarios para la reserva (fase 03)
  'NO_ADMITIDA',
  'PLAZA_RESERVADA', //        lo moverá el módulo de cobros (fase 03)
  'MATRICULADA', //            lo moverá el módulo de matrícula (fase 04)
  'DESCARTADA', //             baja, duplicada, desiste…
]);

/** Canal por el que llega la solicitud (filtro "Origen" del pipeline). */
export const canalSolicitudEnum = pgEnum('canal_solicitud', [
  'SOLICITUD_WEB',
  'TELEFONO',
  'PRESENCIAL',
  'PUERTAS_ABIERTAS',
  'HERMANA_EN_EL_CENTRO',
]);

export const tipoDocumentoEnum = pgEnum('tipo_documento', ['BOLETIN_NOTAS']);

/**
 * Estado de una franja ocupada en la agenda del equipo directivo.
 * La disponibilidad no se guarda: es la jornada laboral menos las franjas activas.
 */
export const estadoFranjaEnum = pgEnum('estado_franja', [
  'RESERVADA', //  propuesta a una familia; bloqueada hasta que elija (o caduque)
  'CONFIRMADA', // la familia la eligió: es una entrevista
  'BLOQUEADA', //  bloqueo manual (reunión, festivo…)
  'LIBERADA', //   ya no ocupa la agenda (histórico)
]);

export const estadoPlantillaEnum = pgEnum('estado_plantilla', ['ACTIVADA', 'BORRADOR']);

export const estadoPropuestaEnum = pgEnum('estado_propuesta', [
  'PENDIENTE',
  'CONFIRMADA',
  'OTRA_FRANJA',
  'ANULADA',
  'CADUCADA',
  'CANCELADA', // la familia canceló la cita desde su enlace (el enlace sigue sirviendo para verlo)
]);

export const estadoEntrevistaEnum = pgEnum('estado_entrevista', [
  'PROGRAMADA', //  "Confirmada" en el calendario
  'REPROGRAMADA',
  'REALIZADA',
  'NO_PRESENTADA',
  'CANCELADA',
]);

export const propositoTokenEnum = pgEnum('proposito_token', ['ELEGIR_CITA', 'COMPLETAR_SOLICITUD']);

export const estadoCorreoEnum = pgEnum('estado_correo', ['PENDIENTE', 'ENVIANDO', 'ENVIADO', 'ERROR']);

/** Reserva de plaza tras la admisión (fase 03). */
export const estadoReservaEnum = pgEnum('estado_reserva', [
  'PENDIENTE', // esperando el pago
  'PAGADA', //    cobrada por completo → la solicitud pasa a PLAZA_RESERVADA
  'VENCIDA', //   pasó el plazo sin pagar; secretaría decide qué hacer
  'ANULADA', //   cambio de decisión o descartada
]);

/** De momento solo la reserva; el resto de conceptos llega con la fase de cobros completa. */
export const conceptoCobroEnum = pgEnum('concepto_cobro', ['RESERVA_PLAZA']);
export const metodoPagoEnum = pgEnum('metodo_pago', ['TRANSFERENCIA', 'EFECTIVO']);

// ── Usuarios internos y sesiones ────────────────────────────────────────────

export const usuarios = pgTable('usuarios', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Siempre en minúsculas (se normaliza en la aplicación). */
  email: text('email').notNull().unique(),
  nombre: text('nombre').notNull(),
  passwordHash: text('password_hash').notNull(),
  /** Códigos de la tabla `roles` (DIRECCION, ADMINISTRACION, SECRETARIA, COMERCIAL). */
  roles: text('roles').array().notNull().default(sql`'{}'::text[]`),
  activo: boolean('activo').notNull().default(true),
  ultimoAcceso: ts('ultimo_acceso'),
  intentosFallidos: integer('intentos_fallidos').notNull().default(0),
  bloqueadoHasta: ts('bloqueado_hasta'),
  createdAt: creado(),
  updatedAt: actualizado(),
});

/**
 * Roles del centro. Los cuatro perfiles acordados con el cliente vienen de serie;
 * Dirección es superadministrador y puede cambiar los permisos del resto.
 */
export const roles = pgTable('roles', {
  codigo: text('codigo').primaryKey(),
  nombre: text('nombre').notNull(),
  descripcion: text('descripcion'),
  /** Tiene todos los permisos y no se le pueden quitar. */
  esSuperadmin: boolean('es_superadmin').notNull().default(false),
  /** Claves del catálogo de permisos (p. ej. "solicitudes.editar"). */
  permisos: text('permisos').array().notNull().default(sql`'{}'::text[]`),
  orden: integer('orden').notNull().default(0),
  updatedAt: actualizado(),
});

/** Ajustes editables desde Configuración (horario de la agenda, etc.). */
export const ajustes = pgTable('ajustes', {
  clave: text('clave').primaryKey(),
  valor: jsonb('valor').notNull(),
  actualizadoPorId: uuid('actualizado_por_id').references(() => usuarios.id),
  updatedAt: actualizado(),
});

/**
 * Refresh tokens con rotación: cada uso emite uno nuevo y revoca el anterior.
 * Si alguien reutiliza un token ya rotado se revoca toda la `familia` (sesión).
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    usuarioId: uuid('usuario_id')
      .notNull()
      .references(() => usuarios.id, { onDelete: 'cascade' }),
    familia: uuid('familia').notNull(),
    /** SHA-256 del token; el token en claro nunca se guarda. */
    tokenHash: text('token_hash').notNull().unique(),
    expiraEn: ts('expira_en').notNull(),
    revocadoEn: ts('revocado_en'),
    reemplazadoPor: uuid('reemplazado_por'),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: creado(),
  },
  (t) => [index('refresh_tokens_usuario_idx').on(t.usuarioId), index('refresh_tokens_familia_idx').on(t.familia)],
);

// ── Catálogo: vías (familia + curso) ────────────────────────────────────────

export const vias = pgTable(
  'vias',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familia: familiaViaEnum('familia').notNull(),
    curso: integer('curso').notNull(),
    nombre: text('nombre').notNull(),
    cursoEscolar: text('curso_escolar').notNull(), // "2027-2028"
    plazas: integer('plazas').notNull(),
    /** GS concertado: el cupo lo asigna la Junta y no se calcula plazas libres. */
    plazasAsignadasPorJunta: boolean('plazas_asignadas_por_junta').notNull().default(false),
    activa: boolean('activa').notNull().default(true),
  },
  (t) => [
    unique('vias_familia_curso_escolar_uq').on(t.familia, t.curso, t.cursoEscolar),
    check('vias_curso_chk', sql`${t.curso} in (1, 2)`),
    check('vias_plazas_chk', sql`${t.plazas} >= 0`),
  ],
);

// ── Familias conocidas (para "familia ya vinculada") ────────────────────────

export const familias = pgTable('familias', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  telefono: text('telefono'),
  nombre: text('nombre').notNull(),
  /**
   * Texto del vínculo mientras no exista el módulo de Alumnado
   * (p. ej. "Hermana en 2º Bachillerato · Clara Márquez Peña").
   */
  vinculo: text('vinculo'),
  createdAt: creado(),
  updatedAt: actualizado(),
});

// ── Solicitudes de admisión ─────────────────────────────────────────────────

export const solicitudes = pgTable(
  'solicitudes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Código legible para la familia: SOL-2026-0001 */
    codigo: text('codigo').notNull().unique(),
    estado: estadoSolicitudEnum('estado').notNull().default('RECIBIDA'),
    viaId: uuid('via_id')
      .notNull()
      .references(() => vias.id),
    familiaId: uuid('familia_id').references(() => familias.id),

    // Alumna
    alumnaNombre: text('alumna_nombre').notNull(),
    alumnaApellidos: text('alumna_apellidos').notNull(),
    /** Obligatorio en el formulario web; puede faltar en altas telefónicas. */
    centroProcedencia: text('centro_procedencia'),
    /** "Modalidad que le interesa" (Ciencias, Marketing y publicidad…). */
    modalidadInteres: text('modalidad_interes'),
    esAlumnaNueva: boolean('es_alumna_nueva').notNull().default(true),

    // Origen
    canal: canalSolicitudEnum('canal').notNull().default('SOLICITUD_WEB'),
    /** Plaza asignada por la Junta de Andalucía (SNEC) en lugar de vía propia. */
    asignadaSnec: boolean('asignada_snec').notNull().default(false),

    // Contacto: "Madre, padre o tutor"
    tutorNombre: text('tutor_nombre').notNull(),
    email: text('email').notNull(),
    telefono: text('telefono').notNull(),

    consentimientoPrivacidad: boolean('consentimiento_privacidad').notNull(),
    consentimientoEn: ts('consentimiento_en').notNull(),

    // Gestión interna
    responsableId: uuid('responsable_id').references(() => usuarios.id),
    observacionesInternas: text('observaciones_internas'),
    /** Resultado de las cinco comprobaciones de la última revisión. */
    revision: jsonb('revision').$type<import('../modules/solicitudes/revision').ResultadoRevision>(),
    revisadaEn: ts('revisada_en'),
    /** Cuándo entró en lista de espera: ordena las posiciones dentro de cada vía. */
    enEsperaDesde: ts('en_espera_desde'),
    /** Campos pedidos en el último "Pedir que complete". */
    camposPendientes: text('campos_pendientes').array().notNull().default(sql`'{}'::text[]`),

    ipOrigen: text('ip_origen'),
    createdAt: creado(),
    updatedAt: actualizado(),
  },
  (t) => [
    index('solicitudes_estado_idx').on(t.estado),
    index('solicitudes_via_estado_idx').on(t.viaId, t.estado),
    index('solicitudes_email_idx').on(t.email),
    index('solicitudes_created_idx').on(t.createdAt),
    check('solicitudes_consentimiento_chk', sql`${t.consentimientoPrivacidad} = true`),
  ],
);

/** Historial auditable de todo lo que le pasa a una solicitud. */
export const solicitudEventos = pgTable(
  'solicitud_eventos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    solicitudId: uuid('solicitud_id')
      .notNull()
      .references(() => solicitudes.id, { onDelete: 'cascade' }),
    tipo: text('tipo').notNull(),
    deEstado: estadoSolicitudEnum('de_estado'),
    aEstado: estadoSolicitudEnum('a_estado'),
    usuarioId: uuid('usuario_id').references(() => usuarios.id),
    /** usuario | familia | sistema */
    actor: text('actor').notNull().default('usuario'),
    detalle: jsonb('detalle').$type<Record<string, unknown>>(),
    createdAt: creado(),
  },
  (t) => [
    index('solicitud_eventos_solicitud_idx').on(t.solicitudId, t.createdAt),
    index('solicitud_eventos_tipo_idx').on(t.tipo, t.createdAt),
  ],
);

/** Aviso "la familia ya eligió fecha": qué respuestas ha visto ya cada usuario. */
export const eventosVistos = pgTable(
  'eventos_vistos',
  {
    usuarioId: uuid('usuario_id')
      .notNull()
      .references(() => usuarios.id, { onDelete: 'cascade' }),
    eventoId: uuid('evento_id')
      .notNull()
      .references(() => solicitudEventos.id, { onDelete: 'cascade' }),
    vistoEn: ts('visto_en').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.usuarioId, t.eventoId] })],
);

// ── Agenda del equipo directivo y citación ──────────────────────────────────

/** Propuesta de cita: de 1 a 3 huecos enviados a la familia de una solicitud. */
export const propuestasCita = pgTable(
  'propuestas_cita',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    solicitudId: uuid('solicitud_id')
      .notNull()
      .references(() => solicitudes.id, { onDelete: 'cascade' }),
    estado: estadoPropuestaEnum('estado').notNull().default('PENDIENTE'),
    enviadaPorId: uuid('enviada_por_id').references(() => usuarios.id),
    mensaje: text('mensaje'),
    /** "Ninguna me encaja": franja que propone la familia y si prefiere que la llamen. */
    franjaSolicitada: text('franja_solicitada'),
    prefiereLlamada: boolean('prefiere_llamada').notNull().default(false),
    /** Duración de cada franja propuesta: 45 o 60 minutos. */
    duracionMin: integer('duracion_min').notNull().default(45),
    respondidaEn: ts('respondida_en'),
    /** Momento en que la familia aceptó una franja: puede cambiarla durante las 24 h siguientes. */
    confirmadaEn: ts('confirmada_en'),
    /** Recordatorio "si no responde en 3 días". */
    recordatorioEnviadoEn: ts('recordatorio_enviado_en'),
    expiraEn: ts('expira_en').notNull(),
    createdAt: creado(),
  },
  (t) => [
    index('propuestas_solicitud_idx').on(t.solicitudId),
    index('propuestas_estado_created_idx').on(t.estado, t.createdAt),
  ],
);

/**
 * Franjas ocupadas de la agenda del equipo directivo.
 * Restricción EXCLUDE (en la migración): dos franjas activas nunca se solapan,
 * así que es imposible dar la misma hora a dos familias aunque lo intenten a la vez.
 */
export const franjasAgenda = pgTable(
  'franjas_agenda',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inicio: ts('inicio').notNull(),
    fin: ts('fin').notNull(),
    estado: estadoFranjaEnum('estado').notNull(),
    /** Si viene de una propuesta, a cuál pertenece y en qué orden se mostró. */
    propuestaId: uuid('propuesta_id').references(() => propuestasCita.id, { onDelete: 'cascade' }),
    orden: integer('orden'),
    /** Bloqueos manuales: motivo visible en la agenda. */
    motivo: text('motivo'),
    creadoPorId: uuid('creado_por_id').references(() => usuarios.id),
    createdAt: creado(),
    updatedAt: actualizado(),
  },
  (t) => [
    index('franjas_inicio_idx').on(t.inicio),
    index('franjas_propuesta_idx').on(t.propuestaId),
    check('franjas_rango_chk', sql`${t.fin} > ${t.inicio}`),
  ],
);

export const entrevistas = pgTable(
  'entrevistas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    solicitudId: uuid('solicitud_id')
      .notNull()
      .references(() => solicitudes.id, { onDelete: 'cascade' }),
    propuestaId: uuid('propuesta_id')
      .unique()
      .references(() => propuestasCita.id),
    /** Franja de la agenda que ocupa. Se suelta (null) si la entrevista se cancela. */
    franjaId: uuid('franja_id')
      .unique()
      .references(() => franjasAgenda.id),
    inicio: ts('inicio').notNull(),
    fin: ts('fin').notNull(),
    lugar: text('lugar').notNull(),
    modalidad: text('modalidad').notNull().default('PRESENCIAL'),
    estado: estadoEntrevistaEnum('estado').notNull().default('PROGRAMADA'),
    notas: text('notas'),
    /** Versión de la invitación .ics: sube en cada cambio de fecha. */
    secuenciaIcs: integer('secuencia_ics').notNull().default(0),
    /** Recordatorio "el día antes" a la familia. */
    recordatorioEnviadoEn: ts('recordatorio_enviado_en'),
    createdAt: creado(),
    updatedAt: actualizado(),
  },
  (t) => [
    index('entrevistas_inicio_idx').on(t.inicio),
    index('entrevistas_estado_inicio_idx').on(t.estado, t.inicio),
    check('entrevistas_presencial_chk', sql`${t.modalidad} = 'PRESENCIAL'`),
  ],
);

// ── Enlaces públicos (sin login) ────────────────────────────────────────────

/** Enlace personal enviado por correo (la familia no tiene cuenta). Solo se guarda su hash. */
export const tokensPublicos = pgTable(
  'tokens_publicos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposito: propositoTokenEnum('proposito').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    solicitudId: uuid('solicitud_id')
      .notNull()
      .references(() => solicitudes.id, { onDelete: 'cascade' }),
    propuestaId: uuid('propuesta_id').references(() => propuestasCita.id, { onDelete: 'cascade' }),
    expiraEn: ts('expira_en').notNull(),
    /**
     * El enlace de la cita es reutilizable: sirve para elegir, cambiar la elección
     * y subir las notas hasta el día de la entrevista. Se revoca al sustituir la
     * propuesta. El de "completar solicitud" se revoca cuando la familia la envía.
     */
    revocadoEn: ts('revocado_en'),
    ultimoUsoEn: ts('ultimo_uso_en'),
    createdAt: creado(),
  },
  (t) => [index('tokens_solicitud_proposito_idx').on(t.solicitudId, t.proposito)],
);

// ── Documentos subidos por la familia ───────────────────────────────────────

/** De momento solo el boletín de notas, que se sube desde el enlace de la cita. */
export const documentos = pgTable(
  'documentos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    solicitudId: uuid('solicitud_id')
      .notNull()
      .references(() => solicitudes.id, { onDelete: 'cascade' }),
    tipo: tipoDocumentoEnum('tipo').notNull(),
    nombreOriginal: text('nombre_original').notNull(),
    mime: text('mime').notNull(),
    tamano: integer('tamano').notNull(),
    /** Clave en el almacenamiento (disco local o S3); nunca una ruta pública. */
    clave: text('clave').notNull(),
    sha256: text('sha256').notNull(),
    subidoPor: text('subido_por').notNull().default('familia'),
    eliminadoEn: ts('eliminado_en'),
    createdAt: creado(),
  },
  (t) => [index('documentos_solicitud_idx').on(t.solicitudId, t.tipo)],
);

// ── Plantillas de correo (módulo Comunicaciones) ────────────────────────────

/**
 * Plantillas HTML editables, vinculadas a un evento del sistema.
 * Solo puede haber una ACTIVADA por evento (índice único parcial en la migración).
 */
export const plantillasCorreo = pgTable(
  'plantillas_correo',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Clave del catálogo de eventos (p. ej. "CITA_CONFIRMADA"). */
    evento: text('evento').notNull(),
    nombre: text('nombre').notNull(),
    asunto: text('asunto').notNull(),
    /** HTML con variables {{alumna}}, {{enlace}}… Se inserta dentro del diseño común. */
    cuerpoHtml: text('cuerpo_html').notNull(),
    estado: estadoPlantillaEnum('estado').notNull().default('BORRADOR'),
    creadoPorId: uuid('creado_por_id').references(() => usuarios.id),
    actualizadoPorId: uuid('actualizado_por_id').references(() => usuarios.id),
    createdAt: creado(),
    updatedAt: actualizado(),
  },
  (t) => [
    index('plantillas_evento_idx').on(t.evento),
    uniqueIndex('plantillas_una_activa_por_evento_uq').on(t.evento).where(sql`${t.estado} = 'ACTIVADA'`),
  ],
);

// ── Reserva de plaza y cobros (fase 03) ─────────────────────────────────────
// Importes siempre en céntimos (30000 = 300,00 €).

/** Reserva de plaza que se crea al admitir: importe y plazo salen de ajustes.reserva. */
export const reservas = pgTable(
  'reservas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    solicitudId: uuid('solicitud_id')
      .notNull()
      .references(() => solicitudes.id),
    importe: integer('importe').notNull(),
    /** Último día para pagar (AAAA-MM-DD, hora de Madrid). */
    fechaLimite: date('fecha_limite', { mode: 'string' }).notNull(),
    estado: estadoReservaEnum('estado').notNull().default('PENDIENTE'),
    creadaPorId: uuid('creada_por_id').references(() => usuarios.id),
    pagadaEn: ts('pagada_en'),
    vencidaEn: ts('vencida_en'),
    anuladaEn: ts('anulada_en'),
    motivoAnulacion: text('motivo_anulacion'),
    recordatorioEnviadoEn: ts('recordatorio_enviado_en'),
    createdAt: creado(),
    updatedAt: actualizado(),
  },
  (t) => [
    // Una sola reserva vigente por solicitud.
    uniqueIndex('reservas_vigente_uq').on(t.solicitudId).where(sql`${t.estado} <> 'ANULADA'`),
    index('reservas_estado_idx').on(t.estado, t.fechaLimite),
    check('reservas_importe_chk', sql`${t.importe} >= 0`),
  ],
);

/** Cobro registrado a mano por administración. No se borra nunca: se anula con motivo. */
export const cobros = pgTable(
  'cobros',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    solicitudId: uuid('solicitud_id')
      .notNull()
      .references(() => solicitudes.id),
    reservaId: uuid('reserva_id').references(() => reservas.id),
    concepto: conceptoCobroEnum('concepto').notNull(),
    importe: integer('importe').notNull(),
    metodo: metodoPagoEnum('metodo').notNull(),
    /** Fecha del pago (AAAA-MM-DD), no la del registro. */
    fecha: date('fecha', { mode: 'string' }).notNull(),
    /** Recibo de la serie R: R-2026-0001. */
    reciboNumero: text('recibo_numero').notNull().unique(),
    registradoPorId: uuid('registrado_por_id')
      .notNull()
      .references(() => usuarios.id),
    observaciones: text('observaciones'),
    anuladoEn: ts('anulado_en'),
    anuladoPorId: uuid('anulado_por_id').references(() => usuarios.id),
    motivoAnulacion: text('motivo_anulacion'),
    createdAt: creado(),
  },
  (t) => [
    index('cobros_solicitud_idx').on(t.solicitudId),
    index('cobros_reserva_idx').on(t.reservaId),
    index('cobros_fecha_idx').on(t.fecha),
    check('cobros_importe_chk', sql`${t.importe} > 0`),
  ],
);

// ── Correo saliente (patrón outbox) ─────────────────────────────────────────

/**
 * Los correos se encolan en la MISMA transacción que el cambio de negocio y
 * un worker los envía. Si el SMTP cae, no se pierde ni la solicitud ni el aviso.
 */
export const correosSalientes = pgTable(
  'correos_salientes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Evento que lo generó (o "PRUEBA"). */
    plantilla: text('plantilla').notNull(),
    plantillaId: uuid('plantilla_id').references(() => plantillasCorreo.id, { onDelete: 'set null' }),
    para: text('para').notNull(),
    asunto: text('asunto').notNull(),
    html: text('html').notNull(),
    texto: text('texto').notNull(),
    adjuntos: jsonb('adjuntos').$type<{ filename: string; content: string; contentType: string }[]>(),
    estado: estadoCorreoEnum('estado').notNull().default('PENDIENTE'),
    intentos: integer('intentos').notNull().default(0),
    ultimoError: text('ultimo_error'),
    programadoPara: ts('programado_para').notNull().defaultNow(),
    reclamadoEn: ts('reclamado_en'),
    enviadoEn: ts('enviado_en'),
    solicitudId: uuid('solicitud_id').references(() => solicitudes.id, { onDelete: 'set null' }),
    createdAt: creado(),
  },
  (t) => [index('correos_estado_programado_idx').on(t.estado, t.programadoPara)],
);

/** Contador transaccional para códigos legibles (SOL-2026-0001) sin carreras. */
export const secuencias = pgTable('secuencias', {
  clave: text('clave').primaryKey(),
  valor: integer('valor').notNull().default(0),
});

// ── Tipos inferidos ─────────────────────────────────────────────────────────
export type Usuario = typeof usuarios.$inferSelect;
export type Via = typeof vias.$inferSelect;
export type Solicitud = typeof solicitudes.$inferSelect;
export type NuevaSolicitud = typeof solicitudes.$inferInsert;
export type FranjaAgenda = typeof franjasAgenda.$inferSelect;
export type Rol = typeof roles.$inferSelect;
export type PlantillaCorreo = typeof plantillasCorreo.$inferSelect;
export type PropuestaCita = typeof propuestasCita.$inferSelect;
export type Entrevista = typeof entrevistas.$inferSelect;
export type EstadoSolicitud = (typeof estadoSolicitudEnum.enumValues)[number];
export type FamiliaVia = (typeof familiaViaEnum.enumValues)[number];
export type CanalSolicitud = (typeof canalSolicitudEnum.enumValues)[number];
export type EstadoEntrevista = (typeof estadoEntrevistaEnum.enumValues)[number];
export type Documento = typeof documentos.$inferSelect;
export type Reserva = typeof reservas.$inferSelect;
export type Cobro = typeof cobros.$inferSelect;
export type MetodoPago = (typeof metodoPagoEnum.enumValues)[number];
