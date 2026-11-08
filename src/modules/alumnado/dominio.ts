import type { EstadoAlumna, OrigenAlumna } from '../../db/schema';

/**
 * Expediente del alumnado. Estados y textos del mockup (pantalla Alumnado):
 * «Reserva confirmada», «En proceso», «Matriculada» y «Baja».
 *
 *   RESERVA ──(empieza la matrícula)──▶ EN_PROCESO ──(matrícula exportada)──▶ MATRICULADA
 *      └──────────────── cualquiera ──▶ BAJA (con motivo) ──(reactivar)──▶ el estado que se indique
 *
 * Mientras no exista la matrícula digital, secretaría mueve los estados a mano.
 */

export const ETIQUETA_ESTADO_ALUMNA: Record<EstadoAlumna, string> = {
  RESERVA: 'Reserva confirmada',
  EN_PROCESO: 'En proceso',
  MATRICULADA: 'Matriculada',
  BAJA: 'Baja',
};

/** Mismos tonos que el mockup (STATUS). */
export const TONO_ESTADO_ALUMNA: Record<EstadoAlumna, 'blue' | 'amber' | 'green' | 'gray'> = {
  RESERVA: 'blue',
  EN_PROCESO: 'amber',
  MATRICULADA: 'green',
  BAJA: 'gray',
};

export const ETIQUETA_ORIGEN_ALUMNA: Record<OrigenAlumna, string> = {
  ADMISION: 'Solicitud de admisión',
  MANUAL: 'Alta manual',
  SENECA: 'Importada de Séneca',
};

/** Estados que se pueden poner a mano (la baja tiene su propia acción, con motivo). */
export const ESTADOS_EDITABLES = ['RESERVA', 'EN_PROCESO', 'MATRICULADA'] as const satisfies readonly EstadoAlumna[];

/** Las que cuentan como «familia ya vinculada» en la revisión de una solicitud. */
export const ESTADOS_VINCULAN_FAMILIA: EstadoAlumna[] = ['RESERVA', 'EN_PROCESO', 'MATRICULADA'];

/** Motivo de la baja automática cuando se anula el cobro que reservó la plaza. */
export const MOTIVO_RESERVA_ANULADA = 'Reserva anulada: se anuló el cobro que la confirmaba';

/** EXP-2026-0001: formato del mockup, correlativo por año de alta. */
export const formatoExpediente = (anio: string, n: number) => `EXP-${anio}-${String(n).padStart(4, '0')}`;

/** Parentesco del tutor de la solicitud: el formulario no dice si es madre, padre u otro. */
export const PARENTESCO_TUTOR_SOLICITUD = 'Madre, padre o tutor';
