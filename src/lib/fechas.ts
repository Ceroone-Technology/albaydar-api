import { env } from '../config/env';

/**
 * Utilidades de fecha en la zona horaria del centro (Europe/Madrid).
 * En BD todo va en UTC (timestamptz); la conversión se hace solo aquí.
 */

/** Desfase (minutos) de la zona respecto a UTC en un instante dado. Tiene en cuenta el horario de verano. */
function offsetMin(instante: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instante);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const comoUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((comoUtc - instante.getTime()) / 60_000);
}

/** "2026-09-01" + "10:00" en hora de Madrid → instante UTC. */
export function horaLocalAUtc(fecha: string, hora: string, tz = env.TZ_CENTRO): Date {
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hora.split(':').map(Number) as [number, number];
  const ingenuo = Date.UTC(y, m - 1, d, hh, mm);
  // Dos pasadas para acertar en los cambios de hora.
  let off = offsetMin(new Date(ingenuo), tz);
  off = offsetMin(new Date(ingenuo - off * 60_000), tz);
  return new Date(ingenuo - off * 60_000);
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('es-ES', { timeZone: env.TZ_CENTRO, ...opts });

const capitalizar = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Martes 1 de septiembre" (formato de la página de cita). */
export const diaLargo = (d: Date) =>
  capitalizar(fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(d).replace(',', ''));

/** "10:00" */
export const hora = (d: Date) => fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

/** "10:00 – 10:45" */
export const franja = (inicio: Date, fin: Date) => `${hora(inicio)} – ${hora(fin)}`;

/** "2026-09-01" en hora local del centro. */
export const fechaLocal = (d: Date) => {
  const p = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};

export const sumarDias = (d: Date, dias: number) => new Date(d.getTime() + dias * 86_400_000);
export const sumarMin = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

/** Recorre días naturales (YYYY-MM-DD) entre dos fechas incluidas. */
export function* diasEntre(desde: string, hasta: string): Generator<{ fecha: string; diaSemana: number }> {
  const [y, m, d] = desde.split('-').map(Number) as [number, number, number];
  const fin = hasta;
  for (let t = Date.UTC(y, m - 1, d); ; t += 86_400_000) {
    const f = new Date(t).toISOString().slice(0, 10);
    if (f > fin) return;
    // 1 = lunes … 7 = domingo
    const dow = new Date(t).getUTCDay() || 7;
    yield { fecha: f, diaSemana: dow };
  }
}

/** "miércoles 28 de octubre a las 10:15" (para frases). */
export const fechaHoraFrase = (d: Date) => `${diaLargo(d).toLowerCase()} a las ${hora(d)}`;
