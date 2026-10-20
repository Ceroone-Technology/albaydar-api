import { and, asc, count, desc, eq, ilike, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { env } from '../../config/env';
import {
  correosSalientes,
  documentos,
  entrevistas,
  franjasAgenda,
  propuestasCita,
  solicitudEventos,
  solicitudes,
  tokensPublicos,
  usuarios,
  vias,
  type EstadoSolicitud,
  type Solicitud,
  type Via,
} from '../../db/schema';
import { db, type Tx } from '../../lib/db';
import { badRequest, conflict, gone, notFound } from '../../lib/errors';
import { hashToken } from '../../lib/crypto';
import { sumarDias } from '../../lib/fechas';
import { enviarEvento } from '../../correo/enviar';
import { boton, lista } from '../../correo/plantillas';
import {
  calcularRevision,
  cambiarEstado,
  crearToken,
  datosCorreo,
  obtenerSolicitud,
  registrarEvento,
  revocarTokens,
  siguienteCodigo,
  urlCompletar,
  type Actor,
} from './comun';
import {
  ACCION_REQUERIDA,
  COLUMNAS_PIPELINE,
  ESTADOS_BANDEJA,
  ETAPA,
  ETIQUETA_CANAL,
  ETIQUETA_ESTADO,
  ETIQUETA_FAMILIA_VIA,
  TONO_ESTADO,
  columnaDe,
  puedeTransicionar,
  type ColumnaPipeline,
} from './dominio';
import type {
  cambiarEstadoBody,
  completarBody,
  gestionBody,
  listarQuery,
  pedirCompletarBody,
  pipelineQuery,
  solicitudInternaBody,
  solicitudPublicaBody,
} from './solicitudes.schemas';

// ── Alta ────────────────────────────────────────────────────────────────────

async function viaActiva(tx: Tx, viaId: string): Promise<Via> {
  const [via] = await tx.select().from(vias).where(and(eq(vias.id, viaId), eq(vias.activa, true))).limit(1);
  if (!via) throw badRequest('VIA_NO_VALIDA', 'La etapa o el curso elegido no está disponible.');
  return via;
}

/** Formulario público: entra con estado "recibida" y se envía acuse a la familia. */
export async function crearDesdeWeb(d: z.infer<typeof solicitudPublicaBody>, ip?: string) {
  return db.transaction(async (tx) => {
    const via = await viaActiva(tx, d.viaId);
    const ahora = new Date();
    const [s] = await tx
      .insert(solicitudes)
      .values({
        codigo: await siguienteCodigo(tx, ahora),
        viaId: via.id,
        alumnaNombre: d.alumnaNombre,
        alumnaApellidos: d.alumnaApellidos,
        centroProcedencia: d.centroProcedencia,
        modalidadInteres: d.modalidadInteres,
        esAlumnaNueva: true,
        canal: 'SOLICITUD_WEB',
        tutorNombre: d.tutorNombre,
        email: d.email,
        telefono: d.telefono,
        consentimientoPrivacidad: true,
        consentimientoEn: ahora,
        ipOrigen: ip,
      })
      .returning();
    await registrarEvento(tx, s!.id, { tipo: 'familia' }, 'CREADA', { aEstado: 'RECIBIDA', detalle: { canal: 'SOLICITUD_WEB' } });
    await enviarEvento(tx, 'SOLICITUD_RECIBIDA', { para: s!.email, vars: datosCorreo(s!, via), solicitudId: s!.id });
    return { codigo: s!.codigo };
  });
}

/** Alta por secretaría (teléfono, presencial, puertas abiertas, SNEC). No envía correo automático. */
export async function crearInterna(d: z.infer<typeof solicitudInternaBody>, usuarioId: string) {
  return db.transaction(async (tx) => {
    const via = await viaActiva(tx, d.viaId);
    const ahora = new Date();
    const [s] = await tx
      .insert(solicitudes)
      .values({
        codigo: await siguienteCodigo(tx, ahora),
        viaId: via.id,
        alumnaNombre: d.alumnaNombre,
        alumnaApellidos: d.alumnaApellidos,
        centroProcedencia: d.centroProcedencia,
        modalidadInteres: d.modalidadInteres,
        esAlumnaNueva: d.esAlumnaNueva,
        canal: d.canal,
        asignadaSnec: d.asignadaSnec,
        tutorNombre: d.tutorNombre,
        email: d.email,
        telefono: d.telefono,
        consentimientoPrivacidad: true,
        consentimientoEn: ahora,
        responsableId: d.responsableId ?? usuarioId,
        observacionesInternas: d.observacionesInternas,
      })
      .returning();
    await registrarEvento(tx, s!.id, { tipo: 'usuario', usuarioId }, 'CREADA', {
      aEstado: 'RECIBIDA',
      detalle: { canal: d.canal, asignadaSnec: d.asignadaSnec },
    });
    return s!;
  });
}

// ── Listados ────────────────────────────────────────────────────────────────

type Filtros = Omit<z.infer<typeof listarQuery>, 'page' | 'pageSize' | 'orden'>;

function condiciones(f: Partial<Filtros>): SQL[] {
  const c: SQL[] = [];
  if (f.vista === 'bandeja') c.push(inArray(solicitudes.estado, ESTADOS_BANDEJA));
  if (f.vista === 'pipeline') c.push(notInArray(solicitudes.estado, ['DESCARTADA', 'NO_ADMITIDA']));
  if (f.columna) {
    const col = COLUMNAS_PIPELINE.find((x) => x.id === f.columna)!;
    c.push(inArray(solicitudes.estado, [...col.estados]));
  }
  if (f.estado?.length) c.push(inArray(solicitudes.estado, f.estado as EstadoSolicitud[]));
  if (f.familiaVia?.length) c.push(inArray(vias.familia, f.familiaVia as Via['familia'][]));
  if (f.curso) c.push(eq(vias.curso, f.curso));
  if (f.canal?.length) c.push(inArray(solicitudes.canal, f.canal as Solicitud['canal'][]));
  if (f.asignadaSnec !== undefined) c.push(eq(solicitudes.asignadaSnec, f.asignadaSnec));
  if (f.responsableId) c.push(eq(solicitudes.responsableId, f.responsableId));
  if (f.q) {
    const t = `%${f.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    c.push(
      or(
        ilike(sql`${solicitudes.alumnaNombre} || ' ' || ${solicitudes.alumnaApellidos}`, t),
        ilike(solicitudes.tutorNombre, t),
        ilike(solicitudes.email, t),
        ilike(solicitudes.telefono, t),
        ilike(solicitudes.codigo, t),
      )!,
    );
  }
  return c;
}

const columnasResumen = {
  id: solicitudes.id,
  codigo: solicitudes.codigo,
  estado: solicitudes.estado,
  alumnaNombre: solicitudes.alumnaNombre,
  alumnaApellidos: solicitudes.alumnaApellidos,
  tutorNombre: solicitudes.tutorNombre,
  email: solicitudes.email,
  telefono: solicitudes.telefono,
  centroProcedencia: solicitudes.centroProcedencia,
  modalidadInteres: solicitudes.modalidadInteres,
  canal: solicitudes.canal,
  asignadaSnec: solicitudes.asignadaSnec,
  revision: solicitudes.revision,
  createdAt: solicitudes.createdAt,
  updatedAt: solicitudes.updatedAt,
  viaFamilia: vias.familia,
  viaCurso: vias.curso,
  viaNombre: vias.nombre,
  responsableId: solicitudes.responsableId,
  responsableNombre: usuarios.nombre,
};


/** Forma de tarjeta/fila común a bandeja, lista y kanban. */
function aResumen(r: FilaResumen) {
  return {
    id: r.id,
    codigo: r.codigo,
    estado: r.estado,
    estadoEtiqueta: ETIQUETA_ESTADO[r.estado],
    estadoTono: TONO_ESTADO[r.estado],
    columna: columnaDe(r.estado),
    alumna: `${r.alumnaNombre} ${r.alumnaApellidos}`.trim(),
    tutor: r.tutorNombre,
    email: r.email,
    telefono: r.telefono,
    centroProcedencia: r.centroProcedencia,
    modalidadInteres: r.modalidadInteres,
    via: { familia: r.viaFamilia, curso: r.viaCurso, nombre: r.viaNombre, etiqueta: ETIQUETA_FAMILIA_VIA[r.viaFamilia], etapa: ETAPA[r.viaFamilia] },
    origen: r.asignadaSnec ? 'Asignada por la Junta (SNEC)' : ETIQUETA_CANAL[r.canal],
    canal: r.canal,
    asignadaSnec: r.asignadaSnec,
    responsable: r.responsableId ? { id: r.responsableId, nombre: r.responsableNombre } : null,
    revision: r.revision,
    creadaEn: r.createdAt,
    actualizadaEn: r.updatedAt,
  };
}

type FilaResumen = Awaited<ReturnType<typeof consultaBase>>[number];

function consultaBase(tx: Tx) {
  return tx
    .select(columnasResumen)
    .from(solicitudes)
    .innerJoin(vias, eq(vias.id, solicitudes.viaId))
    .leftJoin(usuarios, eq(usuarios.id, solicitudes.responsableId));
}

export async function listar(q: z.infer<typeof listarQuery>) {
  const where = and(...condiciones(q));
  const orden =
    q.orden === 'antiguas' ? asc(solicitudes.createdAt) : q.orden === 'actualizadas' ? desc(solicitudes.updatedAt) : desc(solicitudes.createdAt);
  const [filas, [total]] = await Promise.all([
    consultaBase(db)
      .where(where)
      .orderBy(orden, desc(solicitudes.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(solicitudes).innerJoin(vias, eq(vias.id, solicitudes.viaId)).where(where),
  ]);
  return { items: filas.map(aResumen), page: q.page, pageSize: q.pageSize, total: total?.n ?? 0 };
}

/**
 * Kanban: totales por columna + las primeras N tarjetas de cada una.
 * Para cientos de tarjetas, el front pide más con GET /solicitudes?columna=…&page=2
 */
export async function pipeline(q: z.infer<typeof pipelineQuery>) {
  const base = condiciones({ ...q, vista: 'pipeline' });
  const columnas = await Promise.all(
    COLUMNAS_PIPELINE.map(async (col) => {
      const where = and(...base, inArray(solicitudes.estado, [...col.estados]));
      const [filas, [total]] = await Promise.all([
        consultaBase(db).where(where).orderBy(desc(solicitudes.updatedAt)).limit(q.porColumna),
        db.select({ n: count() }).from(solicitudes).innerJoin(vias, eq(vias.id, solicitudes.viaId)).where(where),
      ]);
      return { id: col.id as ColumnaPipeline, titulo: col.titulo, estados: col.estados, total: total?.n ?? 0, items: filas.map(aResumen) };
    }),
  );
  return { columnas };
}

/** Contadores para el badge del menú y el dashboard. */
export async function contadores() {
  const filas = await db.select({ estado: solicitudes.estado, n: count() }).from(solicitudes).groupBy(solicitudes.estado);
  const porEstado = Object.fromEntries(filas.map((f) => [f.estado, f.n])) as Partial<Record<EstadoSolicitud, number>>;
  const bandeja = ESTADOS_BANDEJA.reduce((t, e) => t + (porEstado[e] ?? 0), 0);
  return { bandeja, porEstado };
}

// ── Detalle ─────────────────────────────────────────────────────────────────

export async function detalle(id: string) {
  const { s, via } = await obtenerSolicitud(db, id);
  const revision = await calcularRevision(db, s, via);

  const [responsable] = s.responsableId
    ? await db.select({ id: usuarios.id, nombre: usuarios.nombre }).from(usuarios).where(eq(usuarios.id, s.responsableId))
    : [];

  const eventos = await db
    .select({
      id: solicitudEventos.id,
      tipo: solicitudEventos.tipo,
      deEstado: solicitudEventos.deEstado,
      aEstado: solicitudEventos.aEstado,
      actor: solicitudEventos.actor,
      usuario: usuarios.nombre,
      detalle: solicitudEventos.detalle,
      fecha: solicitudEventos.createdAt,
    })
    .from(solicitudEventos)
    .leftJoin(usuarios, eq(usuarios.id, solicitudEventos.usuarioId))
    .where(eq(solicitudEventos.solicitudId, id))
    .orderBy(desc(solicitudEventos.createdAt));

  // Propuesta vigente (la última no anulada) con sus huecos.
  const [propuesta] = await db
    .select()
    .from(propuestasCita)
    .where(and(eq(propuestasCita.solicitudId, id), notInArray(propuestasCita.estado, ['ANULADA'])))
    .orderBy(desc(propuestasCita.createdAt))
    .limit(1);
  const huecos = propuesta
    ? await db
        .select({ id: franjasAgenda.id, inicio: franjasAgenda.inicio, fin: franjasAgenda.fin, estado: franjasAgenda.estado, orden: franjasAgenda.orden })
        .from(franjasAgenda)
        .where(eq(franjasAgenda.propuestaId, propuesta.id))
        .orderBy(asc(franjasAgenda.inicio))
    : [];

  const [entrevista] = await db
    .select()
    .from(entrevistas)
    .where(and(eq(entrevistas.solicitudId, id), notInArray(entrevistas.estado, ['CANCELADA'])))
    .orderBy(desc(entrevistas.createdAt))
    .limit(1);

  const docs = await db
    .select({ id: documentos.id, tipo: documentos.tipo, nombre: documentos.nombreOriginal, mime: documentos.mime, tamano: documentos.tamano, subidoEn: documentos.createdAt })
    .from(documentos)
    .where(and(eq(documentos.solicitudId, id), isNull(documentos.eliminadoEn)));

  const correos = await db
    .select({ id: correosSalientes.id, plantilla: correosSalientes.plantilla, para: correosSalientes.para, asunto: correosSalientes.asunto, estado: correosSalientes.estado, enviadoEn: correosSalientes.enviadoEn, creadoEn: correosSalientes.createdAt })
    .from(correosSalientes)
    .where(eq(correosSalientes.solicitudId, id))
    .orderBy(desc(correosSalientes.createdAt));

  return {
    ...s,
    estadoEtiqueta: ETIQUETA_ESTADO[s.estado],
    estadoTono: TONO_ESTADO[s.estado],
    columna: columnaDe(s.estado),
    origen: s.asignadaSnec ? 'Asignada por la Junta (SNEC)' : ETIQUETA_CANAL[s.canal],
    via: { ...via, etiqueta: ETIQUETA_FAMILIA_VIA[via.familia], etapa: ETAPA[via.familia] },
    responsable: responsable ?? null,
    revision,
    propuesta: propuesta ? { ...propuesta, huecos } : null,
    entrevista: entrevista ?? null,
    documentos: docs,
    correos,
    eventos,
  };
}

// ── Gestión interna ─────────────────────────────────────────────────────────

export async function actualizarGestion(id: string, d: z.infer<typeof gestionBody>, usuarioId: string) {
  return db.transaction(async (tx) => {
    const { s } = await obtenerSolicitud(tx, id, true);
    if (d.responsableId) {
      const [u] = await tx.select({ id: usuarios.id }).from(usuarios).where(and(eq(usuarios.id, d.responsableId), eq(usuarios.activo, true)));
      if (!u) throw badRequest('RESPONSABLE_NO_VALIDO', 'El responsable no existe o está desactivado.');
    }
    const cambios: Partial<Solicitud> = {};
    if (d.responsableId !== undefined) cambios.responsableId = d.responsableId;
    if (d.observacionesInternas !== undefined) cambios.observacionesInternas = d.observacionesInternas;
    if (d.asignadaSnec !== undefined) cambios.asignadaSnec = d.asignadaSnec;
    if (d.canal !== undefined) cambios.canal = d.canal;
    const [act] = await tx.update(solicitudes).set(cambios).where(eq(solicitudes.id, id)).returning();
    const campos = Object.keys(cambios).filter((k) => k !== 'observacionesInternas');
    if (campos.length || cambios.observacionesInternas !== undefined) {
      await registrarEvento(tx, id, { tipo: 'usuario', usuarioId }, 'GESTION_ACTUALIZADA', {
        detalle: {
          campos: Object.keys(cambios),
          ...(cambios.responsableId !== undefined ? { responsableAnterior: s.responsableId, responsableNuevo: cambios.responsableId } : {}),
        },
      });
    }
    return act!;
  });
}

/** "Revisar": calcula y guarda las cinco comprobaciones; si estaba recibida pasa a "en revisión". */
export async function revisar(id: string, usuarioId: string) {
  return db.transaction(async (tx) => {
    const { s, via } = await obtenerSolicitud(tx, id, true);
    const revision = await calcularRevision(tx, s, via);
    await tx.update(solicitudes).set({ revision, revisadaEn: new Date() }).where(eq(solicitudes.id, id));
    const actor: Actor = { tipo: 'usuario', usuarioId };
    if (s.estado === 'RECIBIDA') await cambiarEstado(tx, s, 'EN_REVISION', actor, 'REVISADA', { completa: revision.completa });
    else await registrarEvento(tx, id, actor, 'REVISADA', { detalle: { completa: revision.completa } });
    return revision;
  });
}

/** "Pedir que complete" / "Reenviar aviso". */
export async function pedirQueComplete(id: string, d: z.infer<typeof pedirCompletarBody>, usuarioId: string) {
  return db.transaction(async (tx) => {
    const { s, via } = await obtenerSolicitud(tx, id, true);
    if (!['RECIBIDA', 'EN_REVISION', 'PENDIENTE_COMPLETAR'].includes(s.estado)) {
      throw conflict('ESTADO_NO_PERMITE', `No se puede pedir que complete una solicitud en estado “${ETIQUETA_ESTADO[s.estado]}”.`);
    }
    if (!s.email) throw badRequest('SIN_CORREO', 'La solicitud no tiene correo de contacto: completa los datos por teléfono.');
    const revision = await calcularRevision(tx, s, via);
    const campos = d.campos?.length ? d.campos : revision.faltan;
    if (!campos.length) throw badRequest('NADA_QUE_COMPLETAR', 'La solicitud ya está completa. Indica qué datos quieres pedir.');

    const reenvio = s.estado === 'PENDIENTE_COMPLETAR';
    await revocarTokens(tx, id, 'COMPLETAR_SOLICITUD');
    const token = await crearToken(tx, {
      proposito: 'COMPLETAR_SOLICITUD',
      solicitudId: id,
      expiraEn: sumarDias(new Date(), env.COMPLETAR_TOKEN_TTL_DAYS),
    });
    await tx.update(solicitudes).set({ camposPendientes: campos, revision, revisadaEn: new Date() }).where(eq(solicitudes.id, id));

    const actor: Actor = { tipo: 'usuario', usuarioId };
    if (reenvio) await registrarEvento(tx, id, actor, 'COMPLETAR_REENVIADO', { detalle: { campos } });
    else await cambiarEstado(tx, s, 'PENDIENTE_COMPLETAR', actor, 'COMPLETAR_SOLICITADO', { campos, mensaje: d.mensaje });

    const enlace = urlCompletar(token);
    await enviarEvento(tx, 'COMPLETAR_SOLICITUD', {
      para: s.email,
      vars: { ...datosCorreo(s, via), campos: lista(campos), mensaje: d.mensaje ?? '', enlace, boton: boton(enlace, 'Completar la solicitud') },
      solicitudId: id,
    });
    return { campos, reenvio };
  });
}

/** Cambio manual de estado (kanban, decisión tras la entrevista, descartar). */
export async function cambiarEstadoManual(id: string, d: z.infer<typeof cambiarEstadoBody>, usuarioId: string) {
  return db.transaction(async (tx) => {
    const { s } = await obtenerSolicitud(tx, id, true);
    if (s.estado === d.estado) return { estado: s.estado };
    if (!puedeTransicionar(s.estado, d.estado)) {
      const accion = ACCION_REQUERIDA[d.estado];
      throw conflict(
        accion ? 'ACCION_REQUERIDA' : 'TRANSICION_NO_PERMITIDA',
        accion
          ? `Para pasar a “${ETIQUETA_ESTADO[d.estado]}” usa la acción correspondiente.`
          : `No se puede pasar de “${ETIQUETA_ESTADO[s.estado]}” a “${ETIQUETA_ESTADO[d.estado]}”.`,
        accion ? { accion } : undefined,
      );
    }
    await cambiarEstado(tx, s, d.estado, { tipo: 'usuario', usuarioId }, 'ESTADO_CAMBIADO', d.motivo ? { motivo: d.motivo } : undefined);
    return { estado: d.estado };
  });
}

// ── Completar desde el enlace público ───────────────────────────────────────

async function tokenCompletar(tx: Tx, token: string) {
  const [t] = await tx.select().from(tokensPublicos).where(eq(tokensPublicos.tokenHash, hashToken(token))).limit(1);
  if (!t || t.proposito !== 'COMPLETAR_SOLICITUD') throw notFound('Enlace no válido.', 'ENLACE_NO_VALIDO');
  if (t.revocadoEn) throw gone('ENLACE_USADO', 'Este enlace ya se ha usado o ha sido sustituido por uno más reciente.');
  if (t.expiraEn < new Date()) throw gone('ENLACE_CADUCADO', 'Este enlace ha caducado. Contacta con secretaría.');
  return t;
}

const CAMPOS_EDITABLES = [
  'alumnaNombre',
  'alumnaApellidos',
  'centroProcedencia',
  'modalidadInteres',
  'tutorNombre',
  'email',
  'telefono',
] as const;

export async function verCompletar(token: string) {
  const t = await tokenCompletar(db, token);
  const { s, via } = await obtenerSolicitud(db, t.solicitudId);
  return {
    codigo: s.codigo,
    curso: `${ETIQUETA_FAMILIA_VIA[via.familia]} ${via.curso}º`,
    camposPendientes: s.camposPendientes,
    datos: Object.fromEntries(CAMPOS_EDITABLES.map((k) => [k, s[k]])),
  };
}

export async function enviarCompletar(token: string, d: z.infer<typeof completarBody>) {
  return db.transaction(async (tx) => {
    const t = await tokenCompletar(tx, token);
    const { s, via } = await obtenerSolicitud(tx, t.solicitudId, true);
    const cambios = Object.fromEntries(Object.entries(d).filter(([, val]) => val !== undefined));
    const [act] = await tx.update(solicitudes).set({ ...cambios, camposPendientes: [] }).where(eq(solicitudes.id, s.id)).returning();
    const revision = await calcularRevision(tx, act!, via);
    await tx.update(solicitudes).set({ revision, revisadaEn: new Date() }).where(eq(solicitudes.id, s.id));
    await tx.update(tokensPublicos).set({ revocadoEn: new Date(), ultimoUsoEn: new Date() }).where(eq(tokensPublicos.id, t.id));
    const detalle = { campos: Object.keys(cambios), completa: revision.completa };
    if (s.estado === 'PENDIENTE_COMPLETAR') await cambiarEstado(tx, s, 'EN_REVISION', { tipo: 'familia' }, 'COMPLETADA_POR_FAMILIA', detalle);
    else await registrarEvento(tx, s.id, { tipo: 'familia' }, 'COMPLETADA_POR_FAMILIA', { detalle });
    return { codigo: s.codigo, completa: revision.completa };
  });
}
