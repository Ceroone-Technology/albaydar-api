import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { env } from '../../config/env';
import {
  correosSalientes,
  documentos,
  entrevistas,
  eventosVistos,
  familias,
  franjasAgenda,
  propuestasCita,
  solicitudEventos,
  solicitudes,
  tokensPublicos,
  usuarios,
  reservas,
  vias,
  type Entrevista,
  type EstadoSolicitud,
  type PropuestaCita,
  type Solicitud,
  type Via,
} from '../../db/schema';
import { db, type Tx } from '../../lib/db';
import { badRequest, conflict, gone, notFound } from '../../lib/errors';
import { hashToken } from '../../lib/crypto';
import { diaLargo, fechaLocal, franja, sumarDias } from '../../lib/fechas';
import { enviarEvento } from '../../correo/enviar';
import { boton, lista } from '../../correo/plantillas';
import {
  calcularRevision,
  calcularRevisiones,
  posicionesEnEspera,
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
import { anularReservaVigente, reservasDe } from '../reservas/reservas.service';
import {
  ACCION_REQUERIDA,
  COLUMNAS_PIPELINE,
  DECISIONES_ADMISION,
  DIAS_AVISO_RESPUESTAS,
  DIAS_RESERVA_POR_VENCER,
  ESTADOS_BANDEJA,
  ESTADOS_PUEDE_PEDIR_COMPLETAR,
  ETAPA,
  ETIQUETA_CANAL,
  ETIQUETA_ESTADO,
  ETIQUETA_ESTADO_ENTREVISTA,
  ETIQUETA_FAMILIA_VIA,
  EVENTOS_RESPUESTA_FAMILIA,
  TONO_ESTADO,
  columnaDe,
  puedeTransicionar,
  siguientesEstados,
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
        asignadaSnec: d.asignadaSnec,
        tutorNombre: d.tutorNombre,
        email: d.email,
        telefono: d.telefono,
        consentimientoPrivacidad: true,
        consentimientoEn: ahora,
        ipOrigen: ip,
      })
      .returning();
    await registrarEvento(tx, s!.id, { tipo: 'familia' }, 'CREADA', {
      aEstado: 'RECIBIDA',
      detalle: { canal: 'SOLICITUD_WEB', asignadaSnec: d.asignadaSnec },
    });
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

/** Otra solicitud de la misma familia (filtro "Familia ya vinculada"). */
const otra = alias(solicitudes, 'otra');

/** Lo que el usuario puede hacer: decide qué transiciones se ofrecen en cada tarjeta. */
export interface Permisos {
  editar: boolean;
  evaluar: boolean;
  cobrar: boolean;
}

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
  if (f.notasPendientes) {
    c.push(
      eq(solicitudes.estado, 'ENTREVISTA_PROGRAMADA'),
      sql`not exists (select 1 from ${documentos} where ${documentos.solicitudId} = ${solicitudes.id} and ${documentos.tipo} = 'BOLETIN_NOTAS' and ${documentos.eliminadoEn} is null)`,
    );
  }
  if (f.reservaPorVencer) {
    // Pendiente a 3 días o menos del plazo, o ya vencida.
    const limite = fechaLocal(sumarDias(new Date(), DIAS_RESERVA_POR_VENCER));
    c.push(
      sql`exists (select 1 from ${reservas} where ${reservas.solicitudId} = ${solicitudes.id} and (${reservas.estado} = 'VENCIDA' or (${reservas.estado} = 'PENDIENTE' and ${reservas.fechaLimite} <= ${limite})))`,
    );
  }
  if (f.familiaVinculada) {
    // La misma regla que la comprobación "Familia ya vinculada" (calcularRevisiones).
    c.push(sql`(
      (${solicitudes.email} <> '' and exists (select 1 from ${familias} where ${familias.email} = ${solicitudes.email}))
      or exists (
        select 1 from ${solicitudes} ${otra} where ${otra.id} <> ${solicitudes.id}
        and ((${solicitudes.email} <> '' and ${otra.email} = ${solicitudes.email}) or ${otra.telefono} = ${solicitudes.telefono})
      )
    )`);
  }
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
  viaId: vias.id,
  viaFamilia: vias.familia,
  viaCurso: vias.curso,
  viaNombre: vias.nombre,
  viaPlazas: vias.plazas,
  viaPlazasJunta: vias.plazasAsignadasPorJunta,
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
    creadaEn: r.createdAt,
    actualizadaEn: r.updatedAt,
  };
}

/** Reserva que aún se puede cobrar: "Registrar cobro" solo se ofrece con una así. */
const reservaAbierta = (r: { estado: string } | null) => r?.estado === 'PENDIENTE' || r?.estado === 'VENCIDA';

/**
 * Lo que la bandeja y el kanban pintan de cada fila, en pocas consultas para toda la página:
 * comprobaciones (recalculadas), propuesta vigente, entrevista, boletín y a dónde se puede mover.
 */
async function enriquecer(filas: FilaResumen[], p: Permisos) {
  if (!filas.length) return [];
  const ids = filas.map((f) => f.id);
  // Fuera de transacción (pool): las consultas van en paralelo, cada una por su conexión.
  const [revisiones, props, ents, docs, reservaDe, posiciones] = await Promise.all([
    calcularRevisiones(
      db,
      filas.map((f) => ({ ...f, via: { id: f.viaId, nombre: f.viaNombre, plazas: f.viaPlazas, plazasAsignadasPorJunta: f.viaPlazasJunta } })),
    ),
    db
      .select()
      .from(propuestasCita)
      .where(and(inArray(propuestasCita.solicitudId, ids), ne(propuestasCita.estado, 'ANULADA')))
      .orderBy(desc(propuestasCita.createdAt)),
    db
      .select()
      .from(entrevistas)
      .where(and(inArray(entrevistas.solicitudId, ids), ne(entrevistas.estado, 'CANCELADA')))
      .orderBy(desc(entrevistas.createdAt)),
    db
      .selectDistinct({ id: documentos.solicitudId })
      .from(documentos)
      .where(and(inArray(documentos.solicitudId, ids), eq(documentos.tipo, 'BOLETIN_NOTAS'), isNull(documentos.eliminadoEn))),
    reservasDe(db, ids),
    posicionesEnEspera(db, filas.filter((f) => f.estado === 'EN_ESPERA').map((f) => f.viaId)),
  ]);
  // Ordenadas de más reciente a más antigua: la primera de cada solicitud es la vigente.
  const propuestaDe = new Map<string, PropuestaCita>();
  for (const x of props) if (!propuestaDe.has(x.solicitudId)) propuestaDe.set(x.solicitudId, x);
  const entrevistaDe = new Map<string, Entrevista>();
  for (const x of ents) if (!entrevistaDe.has(x.solicitudId)) entrevistaDe.set(x.solicitudId, x);
  const huecos = propuestaDe.size
    ? await db
        .select()
        .from(franjasAgenda)
        .where(inArray(franjasAgenda.propuestaId, [...propuestaDe.values()].map((x) => x.id)))
        .orderBy(asc(franjasAgenda.inicio))
    : [];
  const conNotas = new Set(docs.map((d) => d.id));

  return filas.map((f) => {
    const revision = revisiones.get(f.id)!;
    const pr = propuestaDe.get(f.id);
    const e = entrevistaDe.get(f.id);
    const reserva = reservaDe.get(f.id) ?? null;
    return {
      ...aResumen(f),
      revision,
      propuesta: pr
        ? {
            id: pr.id,
            estado: pr.estado,
            duracion: pr.duracionMin,
            enviadaEn: pr.createdAt,
            respondidaEn: pr.respondidaEn,
            reservadasHasta: pr.expiraEn,
            alternativa: pr.estado === 'OTRA_FRANJA' ? { franja: pr.franjaSolicitada, prefiereLlamada: pr.prefiereLlamada } : null,
            fechas: huecos
              .filter((h) => h.propuestaId === pr.id)
              .map((h) => ({ id: h.id, inicio: h.inicio, fin: h.fin, dia: diaLargo(h.inicio), franja: franja(h.inicio, h.fin), estado: h.estado })),
          }
        : null,
      entrevista: e
        ? {
            id: e.id, inicio: e.inicio, fin: e.fin, dia: diaLargo(e.inicio), franja: franja(e.inicio, e.fin),
            estado: e.estado, estadoEtiqueta: ETIQUETA_ESTADO_ENTREVISTA[e.estado], notas: e.notas,
          }
        : null,
      notasSubidas: conNotas.has(f.id),
      reserva,
      posicionEspera: posiciones.get(f.id) ?? null,
      siguientes: siguientesEstados(f.estado, { ...p, puedeCitar: revision.puedeCitar, reservaPendiente: reservaAbierta(reserva) }),
    };
  });
}

type FilaResumen = Awaited<ReturnType<typeof consultaBase>>[number];

function consultaBase(tx: Tx) {
  return tx
    .select(columnasResumen)
    .from(solicitudes)
    .innerJoin(vias, eq(vias.id, solicitudes.viaId))
    .leftJoin(usuarios, eq(usuarios.id, solicitudes.responsableId));
}

const contar = (where: SQL | undefined) =>
  db.select({ n: count() }).from(solicitudes).innerJoin(vias, eq(vias.id, solicitudes.viaId)).where(where);

export async function listar(q: z.infer<typeof listarQuery>, p: Permisos) {
  const where = and(...condiciones(q));
  const orden =
    q.orden === 'antiguas' ? asc(solicitudes.createdAt) : q.orden === 'actualizadas' ? desc(solicitudes.updatedAt) : desc(solicitudes.createdAt);
  const [filas, [total]] = await Promise.all([
    consultaBase(db)
      .where(where)
      .orderBy(orden, desc(solicitudes.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    contar(where),
  ]);
  return { items: await enriquecer(filas, p), page: q.page, pageSize: q.pageSize, total: total?.n ?? 0 };
}

/**
 * Kanban: totales por columna + las primeras N tarjetas de cada una.
 * Para cientos de tarjetas, el front pide más con GET /solicitudes?columna=…&page=2
 * `total` = solicitudes en el embudo sin filtros; `coinciden` = las que cumplen los filtros.
 */
export async function pipeline(q: z.infer<typeof pipelineQuery>, p: Permisos) {
  const base = condiciones({ ...q, vista: 'pipeline' });
  const [columnas, [todas]] = await Promise.all([
    Promise.all(
      COLUMNAS_PIPELINE.map(async (col) => {
        const where = and(...base, inArray(solicitudes.estado, [...col.estados]));
        const [filas, [total]] = await Promise.all([
          consultaBase(db).where(where).orderBy(desc(solicitudes.updatedAt)).limit(q.porColumna),
          contar(where),
        ]);
        return { id: col.id as ColumnaPipeline, titulo: col.titulo, estados: col.estados, total: total?.n ?? 0, filas };
      }),
    ),
    contar(and(...condiciones({ vista: 'pipeline' }))),
  ]);
  const items = new Map((await enriquecer(columnas.flatMap((c) => c.filas), p)).map((i) => [i.id, i]));
  return {
    total: todas?.n ?? 0,
    coinciden: columnas.reduce((t, c) => t + c.total, 0),
    columnas: columnas.map(({ filas, ...c }) => ({ ...c, items: filas.map((f) => items.get(f.id)!) })),
  };
}

/** Contadores para el badge del menú y el dashboard. */
export async function contadores() {
  const filas = await db.select({ estado: solicitudes.estado, n: count() }).from(solicitudes).groupBy(solicitudes.estado);
  const porEstado = Object.fromEntries(filas.map((f) => [f.estado, f.n])) as Partial<Record<EstadoSolicitud, number>>;
  const bandeja = ESTADOS_BANDEJA.reduce((t, e) => t + (porEstado[e] ?? 0), 0);
  return { bandeja, porEstado };
}

// ── Detalle ─────────────────────────────────────────────────────────────────

/** Ficha. Las comprobaciones se recalculan en cada lectura (las plazas cambian con otras solicitudes). */
export async function detalle(id: string, p: Permisos) {
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

  const reserva = (await reservasDe(db, [id])).get(id) ?? null;
  const posicionEspera = s.estado === 'EN_ESPERA' ? ((await posicionesEnEspera(db, [via.id])).get(id) ?? null) : null;

  return {
    ...s,
    estadoEtiqueta: ETIQUETA_ESTADO[s.estado],
    estadoTono: TONO_ESTADO[s.estado],
    columna: columnaDe(s.estado),
    origen: s.asignadaSnec ? 'Asignada por la Junta (SNEC)' : ETIQUETA_CANAL[s.canal],
    via: { ...via, etiqueta: ETIQUETA_FAMILIA_VIA[via.familia], etapa: ETAPA[via.familia] },
    responsable: responsable ?? null,
    revision,
    siguientes: siguientesEstados(s.estado, { ...p, puedeCitar: revision.puedeCitar, reservaPendiente: reservaAbierta(reserva) }),
    reserva,
    posicionEspera,
    propuesta: propuesta ? { ...propuesta, huecos } : null,
    entrevista: entrevista ?? null,
    documentos: docs,
    correos,
    eventos,
  };
}

// ── Aviso "la familia ya eligió fecha" ──────────────────────────────────────

/**
 * Respuestas de las familias de los últimos días que este usuario aún no ha visto.
 * Al elegir fecha, la solicitud sale de la bandeja: este aviso es lo que lo cuenta.
 */
export async function respuestasFamilia(usuarioId: string) {
  const filas = await db
    .select({ ev: solicitudEventos, s: solicitudes, e: entrevistas })
    .from(solicitudEventos)
    .innerJoin(solicitudes, eq(solicitudes.id, solicitudEventos.solicitudId))
    .leftJoin(entrevistas, eq(entrevistas.id, sql`(${solicitudEventos.detalle}->>'entrevistaId')::uuid`))
    .leftJoin(eventosVistos, and(eq(eventosVistos.eventoId, solicitudEventos.id), eq(eventosVistos.usuarioId, usuarioId)))
    .where(
      and(
        inArray(solicitudEventos.tipo, [...EVENTOS_RESPUESTA_FAMILIA]),
        gte(solicitudEventos.createdAt, sumarDias(new Date(), -DIAS_AVISO_RESPUESTAS)),
        isNull(eventosVistos.eventoId),
      ),
    )
    .orderBy(desc(solicitudEventos.createdAt));

  return {
    items: filas.map(({ ev, s, e }) => {
      // La fecha elegida en ese momento (si luego la cambió, el evento siguiente trae la nueva).
      const inicio = typeof ev.detalle?.inicio === 'string' ? new Date(ev.detalle.inicio) : e?.inicio;
      const fin = inicio && e ? new Date(inicio.getTime() + (e.fin.getTime() - e.inicio.getTime())) : null;
      return {
        eventoId: ev.id,
        tipo: ev.tipo,
        fecha: ev.createdAt,
        solicitud: { id: s.id, codigo: s.codigo, alumna: `${s.alumnaNombre} ${s.alumnaApellidos}`.trim(), estado: s.estado },
        cita: inicio && fin ? { inicio, fin, dia: diaLargo(inicio), franja: franja(inicio, fin) } : null,
      };
    }),
  };
}

/** "Visto": no se vuelve a avisar a este usuario de esas respuestas. Ignora ids que no sean respuestas. */
export async function marcarRespuestasVistas(usuarioId: string, eventoIds: string[]) {
  const validos = await db
    .select({ id: solicitudEventos.id })
    .from(solicitudEventos)
    .where(and(inArray(solicitudEventos.id, eventoIds), inArray(solicitudEventos.tipo, [...EVENTOS_RESPUESTA_FAMILIA])));
  if (validos.length) {
    await db
      .insert(eventosVistos)
      .values(validos.map((v) => ({ usuarioId, eventoId: v.id })))
      .onConflictDoNothing();
  }
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
    if (!ESTADOS_PUEDE_PEDIR_COMPLETAR.includes(s.estado)) {
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
    // Las decisiones de admisión notifican y crean o anulan la reserva: van por POST /decision.
    if (DECISIONES_ADMISION.includes(d.estado) && puedeTransicionar(s.estado, d.estado)) {
      throw conflict('ACCION_REQUERIDA', `Para pasar a “${ETIQUETA_ESTADO[d.estado]}” usa “Registrar decisión”.`, { accion: 'DECIDIR' });
    }
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
    const actor: Actor = { tipo: 'usuario', usuarioId };
    // Descartar una admitida: su reserva pendiente deja de valer (si tiene cobros, 409).
    if (s.estado === 'ADMITIDA') await anularReservaVigente(tx, s.id, `Pasa a ${ETIQUETA_ESTADO[d.estado]}`, actor);
    await cambiarEstado(tx, s, d.estado, actor, 'ESTADO_CAMBIADO', d.motivo ? { motivo: d.motivo } : undefined);
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
