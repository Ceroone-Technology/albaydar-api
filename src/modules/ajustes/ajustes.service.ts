import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ajustes, familiaViaEnum, metodoPagoEnum, type FamiliaVia } from '../../db/schema';
import { db, type Tx } from '../../lib/db';
import { ibanValido, normalizarIban } from '../../lib/dinero';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM.');
const aMin = (h: string) => {
  const [a, b] = h.split(':').map(Number) as [number, number];
  return a * 60 + b;
};

/** Horario de entrevistas del equipo directivo. */
export const agendaConfigSchema = z
  .object({
    /** 1 = lunes … 7 = domingo. Por defecto, lunes a viernes. */
    diasSemana: z.array(z.number().int().min(1).max(7)).min(1),
    horaInicio: hhmm,
    horaFin: hhmm,
    /** Duraciones que secretaría puede elegir al proponer (la entrevista dura 45 a 60 min). */
    duraciones: z.array(z.number().int().min(15).max(180)).min(1),
    duracionPorDefecto: z.number().int().min(15).max(180),
    /** Cada cuántos minutos puede empezar una entrevista (09:00, 09:30…). */
    pasoMin: z.number().int().refine((n) => [5, 10, 15, 20, 30, 60].includes(n), 'Paso de 5, 10, 15, 20, 30 o 60 minutos.'),
    /** Antelación mínima para proponer una hora (no se ofrecen horas de dentro de un rato). */
    antelacionMinHoras: z.number().min(0).max(168),
    /** Fechas sin entrevistas (festivos, claustros…), AAAA-MM-DD. */
    diasNoLectivos: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  })
  .refine((c) => aMin(c.horaFin) > aMin(c.horaInicio), { message: 'La hora de fin debe ser posterior a la de inicio.', path: ['horaFin'] })
  .refine((c) => c.duraciones.includes(c.duracionPorDefecto), { message: 'La duración por defecto debe estar entre las permitidas.', path: ['duracionPorDefecto'] });

export type AgendaConfig = z.infer<typeof agendaConfigSchema>;

/** Jornada laboral acordada: lunes a viernes de 8:00 a 18:00, entrevistas de 45 o 60 minutos. */
export const AGENDA_POR_DEFECTO: AgendaConfig = {
  diasSemana: [1, 2, 3, 4, 5],
  horaInicio: '08:00',
  horaFin: '18:00',
  duraciones: [45, 60],
  duracionPorDefecto: 45,
  pasoMin: 30,
  antelacionMinHoras: 2,
  diasNoLectivos: [],
};

export async function agendaConfig(tx: Tx = db): Promise<AgendaConfig> {
  const [f] = await tx.select().from(ajustes).where(eq(ajustes.clave, 'agenda'));
  const r = agendaConfigSchema.safeParse({ ...AGENDA_POR_DEFECTO, ...((f?.valor as object) ?? {}) });
  return r.success ? r.data : AGENDA_POR_DEFECTO;
}

export async function guardarAgendaConfig(valor: AgendaConfig, usuarioId: string) {
  await db
    .insert(ajustes)
    .values({ clave: 'agenda', valor, actualizadoPorId: usuarioId })
    .onConflictDoUpdate({ target: ajustes.clave, set: { valor, actualizadoPorId: usuarioId } });
  return valor;
}

// ── Reserva de plaza ────────────────────────────────────────────────────────

const centimos = z.number().int('En céntimos, sin decimales.').min(0).max(10_000_000);

/** Importe, cuenta y plazo de la reserva. El IBAN y el importe llegan a las plantillas como variables. */
export const reservaConfigSchema = z.object({
  /** Importe general en céntimos (30000 = 300,00 €). */
  importe: centimos,
  /** Excepciones por vía; si una vía no está, se usa el importe general. */
  importesPorVia: z.partialRecord(z.enum(familiaViaEnum.enumValues), centimos).default({}),
  iban: z
    .string()
    .transform(normalizarIban)
    .refine(ibanValido, 'IBAN no válido: revisa los dígitos de control.'),
  titular: z.string().trim().min(1).max(120),
  /** Días naturales desde la admisión para pagar. */
  plazoDias: z.number().int().min(1).max(90),
  metodos: z.array(z.enum(metodoPagoEnum.enumValues)).min(1),
});

export type ReservaConfig = z.infer<typeof reservaConfigSchema>;

/** Decisión del cliente (21/10/2026): 300 € para todas las vías, transferencia o efectivo, 15 días. IBAN provisional. */
export const RESERVA_POR_DEFECTO: ReservaConfig = {
  importe: 30000,
  importesPorVia: {},
  iban: 'ES9121000418450200051332',
  titular: 'Centro Educativo Albaydar',
  plazoDias: 15,
  metodos: ['TRANSFERENCIA', 'EFECTIVO'],
};

export async function reservaConfig(tx: Tx = db): Promise<ReservaConfig> {
  const [f] = await tx.select().from(ajustes).where(eq(ajustes.clave, 'reserva'));
  const r = reservaConfigSchema.safeParse({ ...RESERVA_POR_DEFECTO, ...((f?.valor as object) ?? {}) });
  return r.success ? r.data : RESERVA_POR_DEFECTO;
}

export async function guardarReservaConfig(valor: ReservaConfig, usuarioId: string) {
  await db
    .insert(ajustes)
    .values({ clave: 'reserva', valor, actualizadoPorId: usuarioId })
    .onConflictDoUpdate({ target: ajustes.clave, set: { valor, actualizadoPorId: usuarioId } });
  return valor;
}

export const importeReserva = (cfg: ReservaConfig, familia: FamiliaVia) => cfg.importesPorVia[familia] ?? cfg.importe;

export { aMin };
