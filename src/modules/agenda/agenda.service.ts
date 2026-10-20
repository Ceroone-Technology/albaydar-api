import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CENTRO } from '../../config/env';
import { entrevistas, huecosAgenda, propuestaHuecos, propuestasCita, solicitudes } from '../../db/schema';
import { db } from '../../lib/db';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { diaLargo, diasEntre, franja, horaLocalAUtc } from '../../lib/fechas';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD.');
const horaHM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM.');

export const rangoQuery = z.object({ desde: fecha, hasta: fecha }).refine((r) => r.desde <= r.hasta, 'El rango de fechas no es válido.');

export const crearHuecoBody = z.object({
  fecha,
  inicio: horaHM,
  fin: horaHM.optional(),
  lugar: z.string().trim().max(120).optional(),
});

export const generarBody = z.object({
  desde: fecha,
  hasta: fecha,
  /** 1 = lunes … 7 = domingo */
  diasSemana: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
  /** Franjas del mockup: 09:00, 10:00, 12:30 y 17:00, de 45 minutos. */
  franjas: z
    .array(z.object({ inicio: horaHM, fin: horaHM }))
    .min(1)
    .max(20)
    .default([
      { inicio: '09:00', fin: '09:45' },
      { inicio: '10:00', fin: '10:45' },
      { inicio: '12:30', fin: '13:15' },
      { inicio: '17:00', fin: '17:45' },
    ]),
  /** Fechas sin huecos (festivos, claustros…). */
  excluir: z.array(fecha).default([]),
});

export const estadoHuecoBody = z.object({ estado: z.enum(['LIBRE', 'BLOQUEADO']) });

const finPorDefecto = (inicio: string) => {
  const [h, m] = inicio.split(':').map(Number) as [number, number];
  const t = h * 60 + m + CENTRO.entrevista.duracionMin;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * Agenda del equipo directivo en un rango (fechas locales de Madrid, ambas incluidas).
 * Cada hueco dice si está libre, ocupado (con qué alumna) o bloqueado, y en cuántas
 * propuestas pendientes aparece (para que secretaría no ofrezca el mismo a demasiadas familias).
 */
export async function listarHuecos(desde: string, hasta: string) {
  const ini = horaLocalAUtc(desde, '00:00');
  const fin = horaLocalAUtc(hasta, '23:59');
  const filas = await db
    .select({
      hueco: huecosAgenda,
      entrevistaId: entrevistas.id,
      solicitudId: solicitudes.id,
      codigo: solicitudes.codigo,
      alumna: sql<string | null>`${solicitudes.alumnaNombre} || ' ' || ${solicitudes.alumnaApellidos}`,
    })
    .from(huecosAgenda)
    .leftJoin(entrevistas, eq(entrevistas.huecoId, huecosAgenda.id))
    .leftJoin(solicitudes, eq(solicitudes.id, entrevistas.solicitudId))
    .where(and(gte(huecosAgenda.inicio, ini), lt(huecosAgenda.inicio, fin)))
    .orderBy(asc(huecosAgenda.inicio));

  const ids = filas.map((f) => f.hueco.id);
  const pendientes = ids.length
    ? await db
        .select({ huecoId: propuestaHuecos.huecoId, n: sql<number>`count(*)::int` })
        .from(propuestaHuecos)
        .innerJoin(propuestasCita, eq(propuestasCita.id, propuestaHuecos.propuestaId))
        .where(and(inArray(propuestaHuecos.huecoId, ids), eq(propuestasCita.estado, 'PENDIENTE')))
        .groupBy(propuestaHuecos.huecoId)
    : [];
  const enPropuestas = new Map(pendientes.map((p) => [p.huecoId, p.n]));
  const ahora = new Date();

  return filas.map((f) => ({
    id: f.hueco.id,
    inicio: f.hueco.inicio,
    fin: f.hueco.fin,
    dia: diaLargo(f.hueco.inicio),
    franja: franja(f.hueco.inicio, f.hueco.fin),
    lugar: f.hueco.lugar,
    estado: f.hueco.estado,
    pasado: f.hueco.inicio <= ahora,
    /** El front lo pinta como "Ocupado" y no deja seleccionarlo. */
    seleccionable: f.hueco.estado === 'LIBRE' && f.hueco.inicio > ahora,
    enPropuestasPendientes: enPropuestas.get(f.hueco.id) ?? 0,
    entrevista: f.entrevistaId ? { id: f.entrevistaId, solicitudId: f.solicitudId, codigo: f.codigo, alumna: f.alumna } : null,
  }));
}

export async function crearHueco(d: z.infer<typeof crearHuecoBody>, usuarioId: string) {
  const inicio = horaLocalAUtc(d.fecha, d.inicio);
  const fin = horaLocalAUtc(d.fecha, d.fin ?? finPorDefecto(d.inicio));
  if (fin <= inicio) throw badRequest('RANGO_INVALIDO', 'La hora de fin debe ser posterior a la de inicio.');
  const lugar = d.lugar ?? CENTRO.entrevista.lugar;
  const solapa = await db
    .select({ id: huecosAgenda.id })
    .from(huecosAgenda)
    .where(and(eq(huecosAgenda.lugar, lugar), lt(huecosAgenda.inicio, fin), sql`${huecosAgenda.fin} > ${inicio}`))
    .limit(1);
  if (solapa.length) throw conflict('HUECO_SOLAPADO', 'Ya hay un hueco que se solapa con esa franja.');
  const [h] = await db.insert(huecosAgenda).values({ inicio, fin, lugar, creadoPorId: usuarioId }).returning();
  return h!;
}

/** Crea los huecos de varias semanas de golpe. Ignora los que ya existen. */
export async function generarHuecos(d: z.infer<typeof generarBody>, usuarioId: string) {
  const excluir = new Set(d.excluir);
  const valores: (typeof huecosAgenda.$inferInsert)[] = [];
  let dias = 0;
  for (const { fecha: f, diaSemana } of diasEntre(d.desde, d.hasta)) {
    if (++dias > 120) throw badRequest('RANGO_DEMASIADO_LARGO', 'Genera como máximo 120 días de una vez.');
    if (!d.diasSemana.includes(diaSemana) || excluir.has(f)) continue;
    for (const fr of d.franjas) {
      const inicio = horaLocalAUtc(f, fr.inicio);
      const fin = horaLocalAUtc(f, fr.fin);
      if (fin <= inicio) throw badRequest('RANGO_INVALIDO', `La franja ${fr.inicio}–${fr.fin} no es válida.`);
      if (inicio > new Date()) valores.push({ inicio, fin, lugar: CENTRO.entrevista.lugar, creadoPorId: usuarioId });
    }
  }
  if (!valores.length) return { creados: 0, existentes: 0 };
  const creados = await db.insert(huecosAgenda).values(valores).onConflictDoNothing().returning({ id: huecosAgenda.id });
  return { creados: creados.length, existentes: valores.length - creados.length };
}

export async function cambiarEstadoHueco(id: string, estado: 'LIBRE' | 'BLOQUEADO') {
  const [h] = await db.select().from(huecosAgenda).where(eq(huecosAgenda.id, id));
  if (!h) throw notFound('Hueco no encontrado.');
  if (h.estado === 'OCUPADO') throw conflict('HUECO_OCUPADO', 'El hueco tiene una entrevista. Cancélala primero desde Entrevistas.');
  const [act] = await db.update(huecosAgenda).set({ estado }).where(eq(huecosAgenda.id, id)).returning();
  return act!;
}

/** Solo se borran huecos que nunca se han propuesto; si no, se bloquean (para conservar el histórico). */
export async function eliminarHueco(id: string) {
  const [h] = await db.select().from(huecosAgenda).where(eq(huecosAgenda.id, id));
  if (!h) throw notFound('Hueco no encontrado.');
  if (h.estado === 'OCUPADO') throw conflict('HUECO_OCUPADO', 'El hueco tiene una entrevista. Cancélala primero desde Entrevistas.');
  const [usado] = await db.select({ id: propuestaHuecos.propuestaId }).from(propuestaHuecos).where(eq(propuestaHuecos.huecoId, id)).limit(1);
  if (usado) throw conflict('HUECO_EN_USO', 'Este hueco ya se ha propuesto a alguna familia. Bloquéalo en lugar de borrarlo.');
  await db.delete(huecosAgenda).where(eq(huecosAgenda.id, id));
}
