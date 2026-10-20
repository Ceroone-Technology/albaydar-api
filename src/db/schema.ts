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

export const rolEnum = pgEnum('rol', [
  'ADMIN', //          configuración y gestión de usuarios
  'DIRECCION', //      equipo directivo, dueño de la agenda de entrevistas
  'SECRETARIA', //     bandeja de admisión y citación
  'ADMINISTRACION', // cobros y facturación (fase posterior)
  'PROFESORADO', //    evaluación (fase posterior)
]);

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

export const estadoHuecoEnum = pgEnum('estado_hueco', ['LIBRE', 'OCUPADO', 'BLOQUEADO']);

export const estadoPropuestaEnum = pgEnum('estado_propuesta', [
  'PENDIENTE',
  'CONFIRMADA',
  'OTRA_FRANJA',
  'ANULADA',
  'CADUCADA',
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

// ── Usuarios internos y sesiones ────────────────────────────────────────────

export const usuarios = pgTable('usuarios', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Siempre en minúsculas (se normaliza en la aplicación). */
  email: text('email').notNull().unique(),
  nombre: text('nombre').notNull(),
  passwordHash: text('password_hash').notNull(),
  roles: rolEnum('roles').array().notNull().default(sql`'{}'::rol[]`),
  activo: boolean('activo').notNull().default(true),
  ultimoAcceso: ts('ultimo_acceso'),
  intentosFallidos: integer('intentos_fallidos').notNull().default(0),
  bloqueadoHasta: ts('bloqueado_hasta'),
  createdAt: creado(),
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
    alumnaFechaNacimiento: date('alumna_fecha_nacimiento', { mode: 'string' }),
    alumnaDni: text('alumna_dni'),
    centroProcedencia: text('centro_procedencia'),
    cursoAnterior: text('curso_anterior'),
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

    /** Campos del formulario público aún sin columna propia (hasta validarlo con el cliente). */
    datosExtra: jsonb('datos_extra').$type<Record<string, unknown>>(),
    comentariosFamilia: text('comentarios_familia'),
    consentimientoPrivacidad: boolean('consentimiento_privacidad').notNull(),
    consentimientoEn: ts('consentimiento_en').notNull(),

    // Gestión interna
    responsableId: uuid('responsable_id').references(() => usuarios.id),
    observacionesInternas: text('observaciones_internas'),
    /** Resultado de las cinco comprobaciones de la última revisión. */
    revision: jsonb('revision').$type<import('../modules/solicitudes/revision').ResultadoRevision>(),
    revisadaEn: ts('revisada_en'),
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
  (t) => [index('solicitud_eventos_solicitud_idx').on(t.solicitudId, t.createdAt)],
);

// ── Agenda del equipo directivo y citación ──────────────────────────────────

export const huecosAgenda = pgTable(
  'huecos_agenda',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inicio: ts('inicio').notNull(),
    fin: ts('fin').notNull(),
    /** La entrevista es siempre presencial en la sala de reuniones de Dirección. */
    lugar: text('lugar').notNull().default('Sala de reuniones de Dirección'),
    estado: estadoHuecoEnum('estado').notNull().default('LIBRE'),
    creadoPorId: uuid('creado_por_id').references(() => usuarios.id),
    createdAt: creado(),
    updatedAt: actualizado(),
  },
  (t) => [
    unique('huecos_inicio_lugar_uq').on(t.inicio, t.lugar),
    index('huecos_inicio_estado_idx').on(t.inicio, t.estado),
    check('huecos_rango_chk', sql`${t.fin} > ${t.inicio}`),
  ],
);

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
    respondidaEn: ts('respondida_en'),
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

export const propuestaHuecos = pgTable(
  'propuesta_huecos',
  {
    propuestaId: uuid('propuesta_id')
      .notNull()
      .references(() => propuestasCita.id, { onDelete: 'cascade' }),
    huecoId: uuid('hueco_id')
      .notNull()
      .references(() => huecosAgenda.id),
    orden: integer('orden').notNull(),
  },
  (t) => [primaryKey({ columns: [t.propuestaId, t.huecoId] })],
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
    /** unique: un hueco solo puede tener una entrevista (garantía contra dobles reservas). */
    huecoId: uuid('hueco_id')
      .unique()
      .references(() => huecosAgenda.id),
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

// ── Correo saliente (patrón outbox) ─────────────────────────────────────────

/**
 * Los correos se encolan en la MISMA transacción que el cambio de negocio y
 * un worker los envía. Si el SMTP cae, no se pierde ni la solicitud ni el aviso.
 */
export const correosSalientes = pgTable(
  'correos_salientes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plantilla: text('plantilla').notNull(),
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
export type HuecoAgenda = typeof huecosAgenda.$inferSelect;
export type PropuestaCita = typeof propuestasCita.$inferSelect;
export type Entrevista = typeof entrevistas.$inferSelect;
export type Rol = (typeof rolEnum.enumValues)[number];
export type EstadoSolicitud = (typeof estadoSolicitudEnum.enumValues)[number];
export type FamiliaVia = (typeof familiaViaEnum.enumValues)[number];
export type CanalSolicitud = (typeof canalSolicitudEnum.enumValues)[number];
export type EstadoEntrevista = (typeof estadoEntrevistaEnum.enumValues)[number];
export type Documento = typeof documentos.$inferSelect;
