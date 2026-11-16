import type { EstadoMatricula, FamiliaVia } from '../../db/schema';
import { horaLocalAUtc, sumarDias } from '../../lib/fechas';
import type { ViaId } from './borrador';

export const ETIQUETA_ESTADO_MATRICULA: Record<EstadoMatricula, string> = {
  BORRADOR: 'Borrador',
  ENVIADA: 'Enviada',
  EXPORTADA: 'Exportada a Séneca',
};

/** Vía del asistente del front ↔ familia de la vía en la BD. */
export const VIA_DE_FAMILIA: Record<FamiliaVia, ViaId> = {
  BACHILLERATO: 'bach',
  CICLOS_CONCERTADOS_GM: 'gm',
  CICLOS_CONCERTADOS_GS: 'gs',
  CICLOS_PRIVADOS_GS: 'gsp',
};

export const FAMILIA_DE_VIA: Record<ViaId, FamiliaVia> = {
  bach: 'BACHILLERATO',
  gm: 'CICLOS_CONCERTADOS_GM',
  gs: 'CICLOS_CONCERTADOS_GS',
  gsp: 'CICLOS_PRIVADOS_GS',
};

/** M-2027-0001: año de inicio del curso escolar. */
export const formatoCodigoMatricula = (cursoEscolar: string, n: number) => `M-${cursoEscolar.slice(0, 4)}-${String(n).padStart(4, '0')}`;

/** "2027-2028" → "2028-2029". */
export const cursoEscolarSiguiente = (c: string) => `${Number(c.slice(0, 4)) + 1}-${Number(c.slice(5)) + 1}`;

/**
 * Caducidad del enlace de la familia: el 30 de septiembre del curso de la matrícula (el curso ya
 * ha empezado), y nunca antes de 30 días desde hoy, para las matrículas tardías.
 */
export function caducidadEnlace(cursoEscolar: string, ahora = new Date()): Date {
  const fin = horaLocalAUtc(`${cursoEscolar.slice(0, 4)}-09-30`, '23:59');
  const minimo = sumarDias(ahora, 30);
  return fin > minimo ? fin : minimo;
}

/** Huecos de la LOPD que firma cada progenitor con su propio enlace. */
export const HUECOS_PROGENITOR = {
  padre: ['lopd-padre', 'lopd-img-padre', 'lopd-pd-padre'],
  madre: ['lopd-madre', 'lopd-img-madre', 'lopd-pd-madre'],
} as const;

export type Progenitor = keyof typeof HUECOS_PROGENITOR;
