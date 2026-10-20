import { and, asc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { CENTRO } from '../../config/env';
import {
  documentos,
  entrevistas,
  estadoEntrevistaEnum,
  familiaViaEnum,
  huecosAgenda,
  propuestaHuecos,
  propuestasCita,
  solicitudes,
  vias,
  type EstadoEntrevista,
} from '../../db/schema';
import { db } from '../../lib/db';
import { conflict, notFound } from '../../lib/errors';
import { diaLargo, franja, horaLocalAUtc } from '../../lib/fechas';
import { encolarCorreo } from '../../correo/outbox';
import * as plantillas from '../../correo/plantillas';
import { cambiarEstado, datosCorreo, obtenerSolicitud, registrarEvento } from '../solicitudes/comun';
import { ETIQUETA_FAMILIA_VIA } from '../solicitudes/dominio';
import { icsEntrevista } from '../citacion/citacion.service';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const lista = <T extends readonly [string, ...string[]]>(v: T) =>
  z
    .union([z.enum(v), z.array(z.enum(v))])
    .optional()
    .transform((x) => (x === undefined ? undefined : Array.isArray(x) ? x : [x]));

export const listarEntrevistasQuery = z.object({
  desde: fecha,
  hasta: fecha,
  estado: lista(estadoEntrevistaEnum.enumValues),
  familiaVia: lista(familiaViaEnum.enumValues),
  curso: z.coerce.number().int().min(1).max(2).optional(),
  q: z.string().trim().max(100).optional(),
  /** Incluir propuestas aún sin respuesta (se pintan como "Sin confirmar"). */
  incluirPendientes: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export const actualizarEntrevistaBody = z
  .object({
    estado: z.enum(['REALIZADA', 'NO_PRESENTADA']).optional(),
    notas: z.string().trim().max(4000).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'Nada que actualizar.');

export const cancelarBody = z.object({
  motivo: z.string().trim().max(500).optional().nullable(),
  notificar: z.boolean().default(true),
});

const ETIQUETA: Record<EstadoEntrevista, string> = {
  PROGRAMADA: 'Confirmada',
  REPROGRAMADA: 'Reprogramada',
  REALIZADA: 'Realizada',
  NO_PRESENTADA: 'No presentada',
  CANCELADA: 'Cancelada',
};

/** Vista calendario semanal y vista lista (mismo endpoint; el front agrupa). */
export async function listar(q: z.infer<typeof listarEntrevistasQuery>) {
  const ini = horaLocalAUtc(q.desde, '00:00');
  const fin = horaLocalAUtc(q.hasta, '23:59');
  const c: SQL[] = [gte(entrevistas.inicio, ini), lt(entrevistas.inicio, fin)];
  c.push(q.estado?.length ? inArray(entrevistas.estado, q.estado) : sql`${entrevistas.estado} <> 'CANCELADA'`);
  const filtrosSolicitud: SQL[] = [];
  if (q.familiaVia?.length) filtrosSolicitud.push(inArray(vias.familia, q.familiaVia));
  if (q.curso) filtrosSolicitud.push(eq(vias.curso, q.curso));
  if (q.q) {
    const t = `%${q.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    filtrosSolicitud.push(or(ilike(sql`${solicitudes.alumnaNombre} || ' ' || ${solicitudes.alumnaApellidos}`, t), ilike(solicitudes.tutorNombre, t), ilike(solicitudes.codigo, t))!);
  }

  const filas = await db
    .select({ e: entrevistas, s: solicitudes, via: vias })
    .from(entrevistas)
    .innerJoin(solicitudes, eq(solicitudes.id, entrevistas.solicitudId))
    .innerJoin(vias, eq(vias.id, solicitudes.viaId))
    .where(and(...c, ...filtrosSolicitud))
    .orderBy(asc(entrevistas.inicio));

  const ids = filas.map((f) => f.s.id);
  const conNotas = new Set(
    ids.length
      ? (
          await db
            .select({ id: documentos.solicitudId })
            .from(documentos)
            .where(and(inArray(documentos.solicitudId, ids), eq(documentos.tipo, 'BOLETIN_NOTAS'), isNull(documentos.eliminadoEn)))
        ).map((d) => d.id)
      : [],
  );

  const items = filas.map(({ e, s, via }) => ({
    id: e.id,
    tipo: 'entrevista' as const,
    inicio: e.inicio,
    fin: e.fin,
    dia: diaLargo(e.inicio),
    franja: franja(e.inicio, e.fin),
    estado: e.estado,
    estadoEtiqueta: ETIQUETA[e.estado],
    alumna: `${s.alumnaNombre} ${s.alumnaApellidos}`,
    familia: s.tutorNombre,
    telefono: s.telefono,
    via: ETIQUETA_FAMILIA_VIA[via.familia],
    curso: `${via.curso}º`,
    con: CENTRO.entrevista.con,
    lugar: e.lugar,
    modalidad: e.modalidad,
    notasRecibidas: conNotas.has(s.id),
    solicitud: { id: s.id, codigo: s.codigo, estado: s.estado },
  }));

  // Huecos propuestos sin respuesta: se muestran en gris como "Sin confirmar".
  let pendientes: unknown[] = [];
  if (q.incluirPendientes && !q.estado?.length) {
    const ps = await db
      .select({ hueco: huecosAgenda, p: propuestasCita, s: solicitudes, via: vias })
      .from(propuestaHuecos)
      .innerJoin(propuestasCita, eq(propuestasCita.id, propuestaHuecos.propuestaId))
      .innerJoin(huecosAgenda, eq(huecosAgenda.id, propuestaHuecos.huecoId))
      .innerJoin(solicitudes, eq(solicitudes.id, propuestasCita.solicitudId))
      .innerJoin(vias, eq(vias.id, solicitudes.viaId))
      .where(and(eq(propuestasCita.estado, 'PENDIENTE'), eq(huecosAgenda.estado, 'LIBRE'), gte(huecosAgenda.inicio, ini), lt(huecosAgenda.inicio, fin), ...filtrosSolicitud))
      .orderBy(asc(huecosAgenda.inicio));
    pendientes = ps.map(({ hueco, p, s, via }) => ({
      id: `${p.id}:${hueco.id}`,
      tipo: 'propuesta' as const,
      inicio: hueco.inicio,
      fin: hueco.fin,
      dia: diaLargo(hueco.inicio),
      franja: franja(hueco.inicio, hueco.fin),
      estado: 'SIN_CONFIRMAR',
      estadoEtiqueta: 'Sin confirmar',
      alumna: `${s.alumnaNombre} ${s.alumnaApellidos}`,
      familia: s.tutorNombre,
      via: ETIQUETA_FAMILIA_VIA[via.familia],
      curso: `${via.curso}º`,
      con: CENTRO.entrevista.con,
      lugar: hueco.lugar,
      solicitud: { id: s.id, codigo: s.codigo, estado: s.estado },
    }));
  }
  return { items, pendientes };
}

export async function actualizar(id: string, d: z.infer<typeof actualizarEntrevistaBody>, usuarioId: string) {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(entrevistas).where(eq(entrevistas.id, id)).for('update');
    if (!e) throw notFound('Entrevista no encontrada.');
    if (e.estado === 'CANCELADA') throw conflict('ENTREVISTA_CANCELADA', 'La entrevista está cancelada.');
    if (d.estado && e.inicio > new Date()) throw conflict('ENTREVISTA_FUTURA', 'No se puede marcar como celebrada una entrevista que aún no ha tenido lugar.');
    const [act] = await tx
      .update(entrevistas)
      .set({ ...(d.estado ? { estado: d.estado } : {}), ...(d.notas !== undefined ? { notas: d.notas } : {}) })
      .where(eq(entrevistas.id, id))
      .returning();
    const actor = { tipo: 'usuario' as const, usuarioId };
    if (d.estado) {
      const { s } = await obtenerSolicitud(tx, e.solicitudId, true);
      if (d.estado === 'REALIZADA' && s.estado === 'ENTREVISTA_PROGRAMADA') {
        await cambiarEstado(tx, s, 'ENTREVISTA_REALIZADA', actor, 'ENTREVISTA_REALIZADA', { entrevistaId: id });
      } else {
        await registrarEvento(tx, s.id, actor, d.estado === 'REALIZADA' ? 'ENTREVISTA_REALIZADA' : 'ENTREVISTA_NO_PRESENTADA', { detalle: { entrevistaId: id } });
      }
    }
    return act!;
  });
}

/** Cancela desde el centro: libera el hueco, anula la propuesta y devuelve la solicitud a revisión. */
export async function cancelar(id: string, d: z.infer<typeof cancelarBody>, usuarioId: string) {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(entrevistas).where(eq(entrevistas.id, id)).for('update');
    if (!e) throw notFound('Entrevista no encontrada.');
    if (!['PROGRAMADA', 'REPROGRAMADA'].includes(e.estado)) throw conflict('NO_CANCELABLE', 'Solo se pueden cancelar entrevistas pendientes.');
    const { s, via } = await obtenerSolicitud(tx, e.solicitudId, true);

    await tx.update(entrevistas).set({ estado: 'CANCELADA', huecoId: null, secuenciaIcs: e.secuenciaIcs + 1, notas: d.motivo ?? e.notas }).where(eq(entrevistas.id, id));
    if (e.huecoId) await tx.update(huecosAgenda).set({ estado: 'LIBRE' }).where(eq(huecosAgenda.id, e.huecoId));
    if (e.propuestaId) await tx.update(propuestasCita).set({ estado: 'ANULADA' }).where(eq(propuestasCita.id, e.propuestaId));
    await tx.execute(sql`update tokens_publicos set revocado_en = now() where solicitud_id = ${s.id} and proposito = 'ELEGIR_CITA' and revocado_en is null`);

    const actor = { tipo: 'usuario' as const, usuarioId };
    if (s.estado === 'ENTREVISTA_PROGRAMADA') await cambiarEstado(tx, s, 'EN_REVISION', actor, 'ENTREVISTA_CANCELADA', { entrevistaId: id, motivo: d.motivo });
    else await registrarEvento(tx, s.id, actor, 'ENTREVISTA_CANCELADA', { detalle: { entrevistaId: id, motivo: d.motivo } });

    if (d.notificar) {
      const datos = datosCorreo(s, via);
      await encolarCorreo(tx, {
        plantilla: 'cita-cancelada',
        para: s.email,
        correo: plantillas.citaCancelada({ ...datos, dia: diaLargo(e.inicio), franja: franja(e.inicio, e.fin), motivo: d.motivo }),
        adjuntos: [{ filename: 'entrevista-albaydar.ics', content: icsEntrevista({ ...e, secuenciaIcs: e.secuenciaIcs + 1 }, datos.alumna, true), contentType: 'text/calendar; charset=utf-8; method=CANCEL' }],
        solicitudId: s.id,
      });
    }
    return { ok: true };
  });
}
