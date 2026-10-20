import type { CanalSolicitud, EstadoSolicitud, FamiliaVia } from '../../db/schema';

/** Etiquetas tal como aparecen en los mockups. */
export const ETIQUETA_FAMILIA_VIA: Record<FamiliaVia, string> = {
  BACHILLERATO: 'Bachillerato',
  CICLOS_CONCERTADOS_GM: 'Ciclos Concertados (GM)',
  CICLOS_CONCERTADOS_GS: 'Ciclos Concertados (GS)',
  CICLOS_PRIVADOS_GS: 'Ciclos Privados (GS)',
};

/** Etapa que usa el pipeline (Bachillerato | FP). */
export const ETAPA: Record<FamiliaVia, 'Bachillerato' | 'FP'> = {
  BACHILLERATO: 'Bachillerato',
  CICLOS_CONCERTADOS_GM: 'FP',
  CICLOS_CONCERTADOS_GS: 'FP',
  CICLOS_PRIVADOS_GS: 'FP',
};

export const ETIQUETA_CANAL: Record<CanalSolicitud, string> = {
  SOLICITUD_WEB: 'Solicitud web',
  TELEFONO: 'Teléfono',
  PRESENCIAL: 'Presencial',
  PUERTAS_ABIERTAS: 'Puertas abiertas',
  HERMANA_EN_EL_CENTRO: 'Hermana en el centro',
};

export const ETIQUETA_ESTADO: Record<EstadoSolicitud, string> = {
  RECIBIDA: 'Solicitud recibida',
  EN_REVISION: 'En revisión',
  PENDIENTE_COMPLETAR: 'Pendiente de la familia',
  CITACION_ENVIADA: 'Esperando a la familia',
  OTRA_FRANJA_SOLICITADA: 'Pide otra franja',
  ENTREVISTA_PROGRAMADA: 'Entrevista programada',
  ENTREVISTA_REALIZADA: 'Evaluada · pendiente de decisión',
  EN_ESPERA: 'En espera',
  ADMITIDA: 'Admitida',
  NO_ADMITIDA: 'No admitida',
  PLAZA_RESERVADA: 'Plaza reservada',
  MATRICULADA: 'Matriculada',
  DESCARTADA: 'Descartada',
};

/** Tono del badge (colores semánticos del front). */
export const TONO_ESTADO: Record<EstadoSolicitud, 'blue' | 'amber' | 'violet' | 'orange' | 'green' | 'gray' | 'red'> = {
  RECIBIDA: 'blue',
  EN_REVISION: 'blue',
  PENDIENTE_COMPLETAR: 'amber',
  CITACION_ENVIADA: 'violet',
  OTRA_FRANJA_SOLICITADA: 'orange',
  ENTREVISTA_PROGRAMADA: 'blue',
  ENTREVISTA_REALIZADA: 'violet',
  EN_ESPERA: 'amber',
  ADMITIDA: 'green',
  NO_ADMITIDA: 'gray',
  PLAZA_RESERVADA: 'amber',
  MATRICULADA: 'green',
  DESCARTADA: 'gray',
};

/** Estados que se ven en la bandeja de admisión (pendientes de acción de secretaría o de la familia). */
export const ESTADOS_BANDEJA: EstadoSolicitud[] = [
  'RECIBIDA',
  'EN_REVISION',
  'PENDIENTE_COMPLETAR',
  'CITACION_ENVIADA',
  'OTRA_FRANJA_SOLICITADA',
];

/** Columnas del pipeline (kanban) del mockup y qué estados agrupa cada una. */
export const COLUMNAS_PIPELINE = [
  { id: 'nueva', titulo: 'Solicitud revisada', estados: ['RECIBIDA', 'EN_REVISION', 'PENDIENTE_COMPLETAR'] },
  { id: 'entrevista', titulo: 'Entrevista programada', estados: ['CITACION_ENVIADA', 'OTRA_FRANJA_SOLICITADA', 'ENTREVISTA_PROGRAMADA'] },
  { id: 'evaluada', titulo: 'Evaluada', estados: ['ENTREVISTA_REALIZADA', 'EN_ESPERA', 'ADMITIDA'] },
  { id: 'reserva', titulo: 'Plaza reservada', estados: ['PLAZA_RESERVADA'] },
  { id: 'matriculado', titulo: 'Matriculada', estados: ['MATRICULADA'] },
] as const satisfies readonly { id: string; titulo: string; estados: readonly EstadoSolicitud[] }[];

export type ColumnaPipeline = (typeof COLUMNAS_PIPELINE)[number]['id'];

export const columnaDe = (e: EstadoSolicitud): ColumnaPipeline | null =>
  COLUMNAS_PIPELINE.find((c) => (c.estados as readonly EstadoSolicitud[]).includes(e))?.id ?? null;

/**
 * Cambios de estado que secretaría puede hacer A MANO (p. ej. arrastrando en el kanban).
 * Los que llevan efectos (pedir que complete, citar, confirmar cita) solo se hacen
 * con su acción específica, que envía el correo y deja trazabilidad.
 */
export const TRANSICIONES_MANUALES: Partial<Record<EstadoSolicitud, EstadoSolicitud[]>> = {
  RECIBIDA: ['EN_REVISION', 'DESCARTADA'],
  EN_REVISION: ['RECIBIDA', 'DESCARTADA'],
  PENDIENTE_COMPLETAR: ['EN_REVISION', 'DESCARTADA'],
  CITACION_ENVIADA: ['DESCARTADA'],
  OTRA_FRANJA_SOLICITADA: ['DESCARTADA'],
  ENTREVISTA_PROGRAMADA: ['ENTREVISTA_REALIZADA', 'DESCARTADA'],
  ENTREVISTA_REALIZADA: ['ADMITIDA', 'EN_ESPERA', 'NO_ADMITIDA'],
  EN_ESPERA: ['ADMITIDA', 'NO_ADMITIDA', 'DESCARTADA'],
  ADMITIDA: ['EN_ESPERA', 'DESCARTADA'],
  NO_ADMITIDA: ['EN_ESPERA'],
  DESCARTADA: ['EN_REVISION'],
};

/**
 * Cuando el destino exige una acción con efectos, el API responde 409 con esta pista
 * para que el front abra el panel correspondiente en lugar de mover la tarjeta.
 */
export const ACCION_REQUERIDA: Partial<Record<EstadoSolicitud, string>> = {
  PENDIENTE_COMPLETAR: 'PEDIR_QUE_COMPLETE',
  CITACION_ENVIADA: 'CITAR_A_ENTREVISTA',
  ENTREVISTA_PROGRAMADA: 'CITAR_A_ENTREVISTA',
  PLAZA_RESERVADA: 'MODULO_COBROS',
  MATRICULADA: 'MODULO_MATRICULA',
};

export const puedeTransicionar = (de: EstadoSolicitud, a: EstadoSolicitud) => TRANSICIONES_MANUALES[de]?.includes(a) ?? false;

/** Nombre de pila del tutor para los saludos ("Hola, Elena"). */
export const nombrePila = (nombreCompleto: string) => nombreCompleto.trim().split(/\s+/)[0] ?? nombreCompleto;

export const nombreVia = (familia: FamiliaVia, curso: number) => `${ETIQUETA_FAMILIA_VIA[familia]} ${curso}º`;
