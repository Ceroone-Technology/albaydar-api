import type { CanalSolicitud, Cobro, EstadoEntrevista, EstadoSolicitud, FamiliaVia, MetodoPago, Reserva } from '../../db/schema';

type EstadoReserva = Reserva['estado'];
type ConceptoCobro = Cobro['concepto'];

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

/** Tonos del badge (colores semánticos del front). Lista cerrada: el front los mapea a sus variantes. */
export const TONOS = ['blue', 'amber', 'violet', 'orange', 'green', 'gray', 'red'] as const;

export const TONO_ESTADO: Record<EstadoSolicitud, (typeof TONOS)[number]> = {
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
  PLAZA_RESERVADA: 'REGISTRAR_COBRO',
  MATRICULADA: 'MODULO_MATRICULA',
};

export const puedeTransicionar = (de: EstadoSolicitud, a: EstadoSolicitud) => TRANSICIONES_MANUALES[de]?.includes(a) ?? false;

/** Decidir la admisión es un permiso aparte ("Registrar decisión de admisión" en el mockup): evaluacion.editar. */
export const DECISIONES_ADMISION: EstadoSolicitud[] = ['ADMITIDA', 'NO_ADMITIDA', 'EN_ESPERA'];

/** Desde dónde se puede "Pedir que complete" y "Citar a entrevista". */
export const ESTADOS_PUEDE_PEDIR_COMPLETAR: EstadoSolicitud[] = ['RECIBIDA', 'EN_REVISION', 'PENDIENTE_COMPLETAR'];
export const ESTADOS_PUEDE_CITAR: EstadoSolicitud[] = ['RECIBIDA', 'EN_REVISION', 'CITACION_ENVIADA', 'OTRA_FRANJA_SOLICITADA', 'ENTREVISTA_PROGRAMADA'];

export interface Siguiente {
  estado: EstadoSolicitud;
  columna: ColumnaPipeline | null;
  /** Si está, no se mueve con PATCH /estado: el front abre el panel de esa acción. */
  accion?: 'PEDIR_QUE_COMPLETE' | 'CITAR_A_ENTREVISTA' | 'DECIDIR' | 'REGISTRAR_COBRO';
}

/**
 * A qué estados puede llevar este usuario una tarjeta, para que el front solo deje
 * soltarla donde se puede. PATCH /estado sigue validando (409 como red de seguridad).
 */
export function siguientesEstados(
  estado: EstadoSolicitud,
  o: { editar: boolean; evaluar: boolean; cobrar: boolean; puedeCitar: boolean; reservaPendiente: boolean },
): Siguiente[] {
  if (!o.editar) return [];
  const r: Siguiente[] = (TRANSICIONES_MANUALES[estado] ?? [])
    .filter((a) => o.evaluar || !DECISIONES_ADMISION.includes(a))
    .map((a) => ({ estado: a, columna: columnaDe(a), ...(DECISIONES_ADMISION.includes(a) ? { accion: 'DECIDIR' as const } : {}) }));
  // Solo hay algo que cobrar si la admitida tiene su reserva pendiente (o vencida).
  if (estado === 'ADMITIDA' && o.cobrar && o.reservaPendiente) {
    r.push({ estado: 'PLAZA_RESERVADA', columna: columnaDe('PLAZA_RESERVADA'), accion: 'REGISTRAR_COBRO' });
  }
  if (estado !== 'PENDIENTE_COMPLETAR' && ESTADOS_PUEDE_PEDIR_COMPLETAR.includes(estado)) {
    r.push({ estado: 'PENDIENTE_COMPLETAR', columna: columnaDe('PENDIENTE_COMPLETAR'), accion: 'PEDIR_QUE_COMPLETE' });
  }
  if (o.puedeCitar && estado !== 'CITACION_ENVIADA' && ESTADOS_PUEDE_CITAR.includes(estado)) {
    r.push({ estado: 'CITACION_ENVIADA', columna: columnaDe('CITACION_ENVIADA'), accion: 'CITAR_A_ENTREVISTA' });
  }
  return r;
}

export const ETIQUETA_ESTADO_ENTREVISTA: Record<EstadoEntrevista, string> = {
  PROGRAMADA: 'Confirmada',
  REPROGRAMADA: 'Reprogramada',
  REALIZADA: 'Realizada',
  NO_PRESENTADA: 'No presentada',
  CANCELADA: 'Cancelada',
};

// ── Reserva de plaza y cobros (fase 03) ─────────────────────────────────────

export const ETIQUETA_ESTADO_RESERVA: Record<EstadoReserva, string> = {
  PENDIENTE: 'Pendiente de pago',
  PAGADA: 'Pagada',
  VENCIDA: 'Vencida',
  ANULADA: 'Anulada',
};

export const ETIQUETA_METODO_PAGO: Record<MetodoPago, string> = {
  TRANSFERENCIA: 'Transferencia',
  EFECTIVO: 'Efectivo',
};

export const ETIQUETA_CONCEPTO_COBRO: Record<ConceptoCobro, string> = {
  RESERVA_PLAZA: 'Reserva de plaza',
};

/** "Reserva por vencer": a 3 días o menos del plazo (o vencida). También es cuando sale el recordatorio. */
export const DIAS_RESERVA_POR_VENCER = 3;

/** "2027-2028" → "2027/28" (como en los correos del mockup). */
export const cursoEscolarCorto = (c: string) => c.replace(/^(\d{4})-\d{2}(\d{2})$/, '$1/$2');

/**
 * Respuestas de la familia que se avisan una vez a cada usuario: elegir o cambiar la fecha (la
 * solicitud sale de la bandeja) y cancelar la cita (vuelve a la bandeja para proponer otras).
 */
export const EVENTOS_RESPUESTA_FAMILIA = ['CITA_CONFIRMADA', 'CITA_CAMBIADA', 'CITA_CANCELADA_FAMILIA'] as const;
export const DIAS_AVISO_RESPUESTAS = 7;

/** Nombre de pila del tutor para los saludos ("Hola, Elena"). */
export const nombrePila = (nombreCompleto: string) => nombreCompleto.trim().split(/\s+/)[0] ?? nombreCompleto;

export const nombreVia = (familia: FamiliaVia, curso: number) => `${ETIQUETA_FAMILIA_VIA[familia]} ${curso}º`;
