import type { Response } from 'express';
import { fechaLocal, hora } from './fechas';

/**
 * Exportaciones a CSV para abrir en Excel tal cual (doble clic):
 * - separador `;` y coma decimal, como espera Excel en español;
 * - BOM UTF-8, para que respete tildes y eñes;
 * - fin de línea CRLF.
 *
 * Una celda que empieza por = + - @ (o tabulador / retorno) la ejecutaría Excel como
 * fórmula (inyección de CSV): se le antepone un apóstrofo. Los teléfonos (+34 …) se
 * anteponen con un espacio, que basta para que sean texto y se leen igual.
 */

export type Celda = string | number | boolean | Date | null | undefined;

export interface Columna<T> {
  titulo: string;
  valor: (fila: T) => Celda;
}

/** Tope de filas de una exportación: muy por encima del volumen del centro. */
export const MAX_FILAS_EXPORTACION = 10_000;

const PELIGROSA = /^[=+\-@\t\r]/;
const TELEFONO = /^\+[\d\s().-]+$/;

const numero = new Intl.NumberFormat('es-ES', { useGrouping: false, maximumFractionDigits: 2 });

function texto(v: Celda): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (typeof v === 'number') return numero.format(v);
  if (v instanceof Date) return fechaHoraCsv(v);
  if (TELEFONO.test(v)) return ` ${v}`;
  return PELIGROSA.test(v) ? `'${v}` : v;
}

function celda(v: Celda): string {
  const t = texto(v);
  return /[";\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function aCsv<T>(columnas: Columna<T>[], filas: T[]): string {
  const lineas = [columnas.map((c) => celda(c.titulo)).join(';'), ...filas.map((f) => columnas.map((c) => celda(c.valor(f))).join(';'))];
  return `﻿${lineas.join('\r\n')}\r\n`;
}

/** "2026-11-05" (fecha del centro) → "05/11/2026". */
export const fechaCsv = (fecha: string | null | undefined) => (fecha ? fecha.split('-').reverse().join('/') : null);

/** Instante → "05/11/2026 10:30", en hora de Madrid. */
export const fechaHoraCsv = (d: Date | string | null | undefined) => {
  if (!d) return '';
  const x = typeof d === 'string' ? new Date(d) : d;
  return `${fechaCsv(fechaLocal(x))} ${hora(x)}`;
};

/** Céntimos → "300,00" (número para Excel, sin «€»: la columna ya lo dice). */
export const eurosCsv = (centimos: number | null | undefined) =>
  centimos === null || centimos === undefined ? null : (centimos / 100).toFixed(2).replace('.', ',');

/**
 * Recorre todas las páginas de un listado con sus mismos filtros: lo exportado es lo que
 * se ve en la pantalla, sin paginar. Corta en MAX_FILAS_EXPORTACION.
 */
export async function todasLasPaginas<Q extends { page: number; pageSize: number }, I>(
  listar: (q: Q) => Promise<{ items: I[]; total: number }>,
  q: Q,
): Promise<I[]> {
  const items: I[] = [];
  for (let page = 1; items.length < MAX_FILAS_EXPORTACION; page++) {
    // En serie a propósito: cada página es una consulta completa al pool.
    const r = await listar({ ...q, page, pageSize: 200 });
    items.push(...r.items);
    if (r.items.length < 200 || items.length >= r.total) break;
  }
  return items.slice(0, MAX_FILAS_EXPORTACION);
}

/** Descarga: `solicitudes-2026-11-05.csv`, sin caché (datos personales). */
export function enviarCsv(res: Response, nombre: string, csv: string) {
  const fichero = `${nombre}-${fechaLocal(new Date())}.csv`;
  res
    .status(200)
    .set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fichero}"`,
      'Cache-Control': 'no-store',
    })
    .send(csv);
}
