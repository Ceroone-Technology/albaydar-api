import { CENTRO } from '../config/env';

/** Escapa texto según RFC 5545. */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Pliega líneas a 75 octetos como pide el estándar. */
function plegar(linea: string): string {
  const out: string[] = [];
  let resto = Buffer.from(linea, 'utf8');
  let primera = true;
  while (resto.length > (primera ? 75 : 74)) {
    let corte = primera ? 75 : 74;
    while (corte > 0 && (resto[corte]! & 0xc0) === 0x80) corte--; // no partir un carácter UTF-8
    out.push((primera ? '' : ' ') + resto.subarray(0, corte).toString('utf8'));
    resto = resto.subarray(corte);
    primera = false;
  }
  out.push((primera ? '' : ' ') + resto.toString('utf8'));
  return out.join('\r\n');
}

export interface EventoIcs {
  uid: string;
  inicio: Date;
  fin: Date;
  titulo: string;
  descripcion: string;
  lugar: string;
  /** Se incrementa en cada cambio para que el calendario actualice el evento. */
  secuencia?: number;
  cancelar?: boolean;
}

export function generarIcs(e: EventoIcs): string {
  const lineas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Centro Educativo Albaydar//Admisiones//ES',
    'CALSCALE:GREGORIAN',
    `METHOD:${e.cancelar ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${e.uid}@albaydar.org`,
    `DTSTAMP:${utc(new Date())}`,
    `DTSTART:${utc(e.inicio)}`,
    `DTEND:${utc(e.fin)}`,
    `SEQUENCE:${e.secuencia ?? 0}`,
    `SUMMARY:${esc(e.titulo)}`,
    `DESCRIPTION:${esc(e.descripcion)}`,
    `LOCATION:${esc(e.lugar)}`,
    `ORGANIZER;CN=${esc(CENTRO.nombre)}:mailto:admisiones@albaydar.org`,
    `STATUS:${e.cancelar ? 'CANCELLED' : 'CONFIRMED'}`,
    ...(e.cancelar
      ? []
      : ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Entrevista en Albaydar', 'TRIGGER:-P1D', 'END:VALARM']),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lineas.map(plegar).join('\r\n') + '\r\n';
}
