import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CENTRO } from '../../config/env';
import { entrevistas, franjasAgenda, propuestasCita, solicitudes, usuarios } from '../../db/schema';
import { db, type Tx } from '../../lib/db';
import { badRequest, codigoPg, conflict, notFound } from '../../lib/errors';
import { diaLargo, diaSiguiente, diasEntre, fechaLocal, franja, hora, horaLocalAUtc, sumarMin } from '../../lib/fechas';
import { aMin, agendaConfig, type AgendaConfig } from '../ajustes/ajustes.service';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD.');
const horaHM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM.');

export const rangoQuery = z
  .object({ desde: fecha, hasta: fecha, duracion: z.coerce.number().int().optional() })
  .refine((r) => r.desde <= r.hasta, 'El rango de fechas no es válido.');

export const bloqueoBody = z.object({
  fecha,
  inicio: horaHM,
  fin: horaHM,
  motivo: z.string().trim().min(1, 'Indica el motivo.').max(200),
});

/** Error de PostgreSQL de la restricción EXCLUDE: la franja se solapa con otra activa. */
export const esSolape = (e: unknown) => codigoPg(e) === '23P01';

const ESTADOS_ACTIVOS = sql`${franjasAgenda.estado} <> 'LIBERADA'`;

/** Franjas activas (reservadas, confirmadas o bloqueadas) que tocan un rango. */
export async function ocupaciones(tx: Tx, ini: Date, fin: Date) {
  return tx
    .select()
    .from(franjasAgenda)
    .where(and(ESTADOS_ACTIVOS, lt(franjasAgenda.inicio, fin), gt(franjasAgenda.fin, ini)))
    .orderBy(asc(franjasAgenda.inicio));
}

/**
 * Primera hora a la que se puede proponer una entrevista: la antelación mínima
 * y, si no se permite el mismo día (lo acordado), mañana a las 00:00 del centro.
 * Devuelve los dos límites por separado para explicar cuál se incumple.
 */
export function primerInicioPermitido(cfg: AgendaConfig, ahora = new Date()): { desde: Date; antelacion: Date; manana: Date | null } {
  const antelacion = new Date(ahora.getTime() + cfg.antelacionMinHoras * 3_600_000);
  const manana = cfg.permitirMismoDia ? null : horaLocalAUtc(diaSiguiente(fechaLocal(ahora)), '00:00');
  return { desde: manana && manana > antelacion ? manana : antelacion, antelacion, manana };
}

/** ¿Cae la franja dentro de la jornada de entrevistas? */
export function dentroDeJornada(inicio: Date, fin: Date, cfg: AgendaConfig): string | null {
  const f = fechaLocal(inicio);
  if (fechaLocal(new Date(fin.getTime() - 1)) !== f) return 'La entrevista debe empezar y acabar el mismo día.';
  const dow = (new Date(`${f}T12:00:00Z`).getUTCDay() || 7) as number;
  if (!cfg.diasSemana.includes(dow)) return 'Ese día no hay entrevistas.';
  if (cfg.diasNoLectivos.includes(f)) return 'Ese día está marcado como no lectivo.';
  const hi = aMin(hora(inicio));
  const hf = aMin(hora(fin)) || 24 * 60;
  if (hi < aMin(cfg.horaInicio) || hf > aMin(cfg.horaFin)) return `Fuera del horario de entrevistas (${cfg.horaInicio}–${cfg.horaFin}).`;
  return null;
}

/**
 * Disponibilidad del equipo directivo: horas de inicio posibles cada `pasoMin`,
 * dentro de la jornada, menos lo ya reservado, confirmado o bloqueado.
 * Devuelve también las no disponibles para pintarlas como "Ocupado" (como en el mockup).
 */
export async function disponibilidad(desde: string, hasta: string, duracionPedida?: number) {
  const cfg = await agendaConfig();
  const duracion = duracionPedida ?? cfg.duracionPorDefecto;
  if (!cfg.duraciones.includes(duracion)) throw badRequest('DURACION_NO_VALIDA', `Duración permitida: ${cfg.duraciones.join(' o ')} minutos.`);

  const ocup = await ocupaciones(db, horaLocalAUtc(desde, '00:00'), horaLocalAUtc(hasta, '23:59'));
  const { antelacion, manana } = primerInicioPermitido(cfg);
  const dias = [];
  let n = 0;
  for (const { fecha: f, diaSemana } of diasEntre(desde, hasta)) {
    if (++n > 62) throw badRequest('RANGO_DEMASIADO_LARGO', 'Consulta como máximo dos meses.');
    if (!cfg.diasSemana.includes(diaSemana)) continue;
    const noLectivo = cfg.diasNoLectivos.includes(f);
    const huecos = [];
    for (let m = aMin(cfg.horaInicio); m + duracion <= aMin(cfg.horaFin); m += cfg.pasoMin) {
      const hh = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const inicio = horaLocalAUtc(f, hh);
      const fin = sumarMin(inicio, duracion);
      const choca = ocup.find((o) => o.inicio < fin && o.fin > inicio);
      const motivo = noLectivo
        ? 'No lectivo'
        : inicio < antelacion
          ? 'Pasado'
          : manana && inicio < manana
            ? 'Mismo día'
            : choca
              ? choca.estado === 'BLOQUEADA'
                ? 'Bloqueado'
                : 'Ocupado'
              : null;
      huecos.push({ inicio, fin, hora: hh, franja: franja(inicio, fin), disponible: !motivo, motivo });
    }
    dias.push({ fecha: f, dia: diaLargo(horaLocalAUtc(f, '12:00')), libres: huecos.filter((h) => h.disponible).length, huecos });
  }
  return { duracion, config: cfg, lugar: CENTRO.entrevista.lugar, dias };
}

/** Vista de agenda: qué ocupa cada franja (reserva de propuesta, entrevista o bloqueo). */
export async function ocupacionDetallada(desde: string, hasta: string) {
  const filas = await db
    .select({
      f: franjasAgenda,
      solicitudId: solicitudes.id,
      codigo: solicitudes.codigo,
      alumna: sql<string | null>`${solicitudes.alumnaNombre} || ' ' || ${solicitudes.alumnaApellidos}`,
      entrevistaId: entrevistas.id,
      creadoPor: usuarios.nombre,
    })
    .from(franjasAgenda)
    .leftJoin(propuestasCita, eq(propuestasCita.id, franjasAgenda.propuestaId))
    .leftJoin(solicitudes, eq(solicitudes.id, propuestasCita.solicitudId))
    .leftJoin(entrevistas, eq(entrevistas.franjaId, franjasAgenda.id))
    .leftJoin(usuarios, eq(usuarios.id, franjasAgenda.creadoPorId))
    .where(and(ESTADOS_ACTIVOS, lt(franjasAgenda.inicio, horaLocalAUtc(hasta, '23:59')), gt(franjasAgenda.fin, horaLocalAUtc(desde, '00:00'))))
    .orderBy(asc(franjasAgenda.inicio));
  return filas.map((r) => ({
    id: r.f.id,
    inicio: r.f.inicio,
    fin: r.f.fin,
    dia: diaLargo(r.f.inicio),
    franja: franja(r.f.inicio, r.f.fin),
    estado: r.f.estado,
    etiqueta: r.f.estado === 'RESERVADA' ? 'Reservada · esperando a la familia' : r.f.estado === 'CONFIRMADA' ? 'Entrevista' : 'Bloqueada',
    motivo: r.f.motivo,
    solicitud: r.solicitudId ? { id: r.solicitudId, codigo: r.codigo, alumna: r.alumna } : null,
    entrevistaId: r.entrevistaId,
    creadoPor: r.creadoPor,
  }));
}

/** Bloqueo manual (reunión, ausencia…). No puede pisar citas ni reservas. */
export async function crearBloqueo(d: z.infer<typeof bloqueoBody>, usuarioId: string) {
  const inicio = horaLocalAUtc(d.fecha, d.inicio);
  const fin = horaLocalAUtc(d.fecha, d.fin);
  if (fin <= inicio) throw badRequest('RANGO_INVALIDO', 'La hora de fin debe ser posterior a la de inicio.');
  try {
    const [f] = await db.insert(franjasAgenda).values({ inicio, fin, estado: 'BLOQUEADA', motivo: d.motivo, creadoPorId: usuarioId }).returning();
    return f!;
  } catch (e) {
    if (esSolape(e)) throw conflict('FRANJA_OCUPADA', 'Esa franja se solapa con una entrevista, una reserva u otro bloqueo.');
    throw e;
  }
}

export async function quitarBloqueo(id: string) {
  const [f] = await db
    .update(franjasAgenda)
    .set({ estado: 'LIBERADA' })
    .where(and(eq(franjasAgenda.id, id), eq(franjasAgenda.estado, 'BLOQUEADA')))
    .returning();
  if (!f) throw notFound('Bloqueo no encontrado.');
}

