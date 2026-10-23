import { and, asc, count, eq, gte, ilike, inArray, isNull, lt, lte, ne, or, sql, sum, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env';
import { cobros, estadoReservaEnum, reservas, solicitudes, vias, type Reserva, type Solicitud, type Via } from '../../db/schema';
import { db, type Tx } from '../../lib/db';
import { euros, formatearIban } from '../../lib/dinero';
import { conflict, notFound } from '../../lib/errors';
import { diaLargo, fechaLocal, horaLocalAUtc, sumarDias } from '../../lib/fechas';
import { logger } from '../../lib/logger';
import { enviarEvento } from '../../correo/enviar';
import { boton } from '../../correo/plantillas';
import { importeReserva, reservaConfig, type ReservaConfig } from '../ajustes/ajustes.service';
import { datosCorreo, obtenerSolicitud, registrarEvento, type Actor } from '../solicitudes/comun';
import { DIAS_RESERVA_POR_VENCER, ETIQUETA_ESTADO_RESERVA, ETIQUETA_METODO_PAGO } from '../solicitudes/dominio';

/**
 * Reserva de plaza (fase 03), con las reglas acordadas con el cliente:
 *  - Se crea al admitir: importe de ajustes.reserva (300 € por defecto) y plazo de 15 días naturales.
 *  - Se paga con uno o varios cobros manuales; al completarse, la solicitud pasa a PLAZA_RESERVADA.
 *  - Un recordatorio a 3 días del vencimiento. Pasado el plazo queda VENCIDA y se avisa a
 *    secretaría y administración, que deciden qué hacer (la plaza no se libera sola).
 */

/** "2026-11-05" → "jueves 5 de noviembre" */
export const fechaTexto = (f: string) => diaLargo(horaLocalAUtc(f, '12:00')).toLowerCase();

/** Días naturales que quedan hasta la fecha límite (negativo si ya pasó). */
export const diasRestantes = (fechaLimite: string, hoy: string) =>
  Math.round((Date.parse(`${fechaLimite}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000);

export function vistaReserva(r: Reserva, pagado: number, hoy = fechaLocal(new Date())) {
  const pendiente = Math.max(0, r.importe - pagado);
  return {
    id: r.id,
    estado: r.estado,
    estadoEtiqueta: ETIQUETA_ESTADO_RESERVA[r.estado],
    importe: r.importe,
    pagado,
    pendiente,
    importeTexto: euros(r.importe),
    pendienteTexto: euros(pendiente),
    fechaLimite: r.fechaLimite,
    fechaLimiteTexto: fechaTexto(r.fechaLimite),
    diasRestantes: r.estado === 'PENDIENTE' || r.estado === 'VENCIDA' ? diasRestantes(r.fechaLimite, hoy) : null,
    recordatorioEnviadoEn: r.recordatorioEnviadoEn,
    creadaEn: r.createdAt,
    pagadaEn: r.pagadaEn,
  };
}

/** Suma de los cobros no anulados de cada reserva (céntimos). */
export async function pagadoPorReserva(tx: Tx, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const filas = await tx
    .select({ id: cobros.reservaId, total: sum(cobros.importe).mapWith(Number) })
    .from(cobros)
    .where(and(inArray(cobros.reservaId, ids), isNull(cobros.anuladoEn)))
    .groupBy(cobros.reservaId);
  return new Map(filas.map((f) => [f.id!, f.total ?? 0]));
}

/** Reserva vigente (no anulada) de cada solicitud, para la bandeja y el kanban. */
export async function reservasDe(tx: Tx, solicitudIds: string[]) {
  if (!solicitudIds.length) return new Map<string, ReturnType<typeof vistaReserva>>();
  const rs = await tx.select().from(reservas).where(and(inArray(reservas.solicitudId, solicitudIds), ne(reservas.estado, 'ANULADA')));
  const pagado = await pagadoPorReserva(tx, rs.map((r) => r.id));
  const hoy = fechaLocal(new Date());
  return new Map(rs.map((r) => [r.solicitudId, vistaReserva(r, pagado.get(r.id) ?? 0, hoy)]));
}

/** Datos de pago para los correos ADMITIDA y RECORDATORIO_PAGO. */
export function varsPago(cfg: ReservaConfig, r: Pick<Reserva, 'fechaLimite'>, pendiente: number) {
  const formas = cfg.metodos.map((m) => (m === 'EFECTIVO' ? 'en efectivo en administración del centro' : ETIQUETA_METODO_PAGO[m].toLowerCase()));
  return {
    importe: euros(pendiente),
    fecha_limite: fechaTexto(r.fechaLimite),
    iban: formatearIban(cfg.iban),
    titular: cfg.titular,
    formas_pago: formas.join(' o '),
  };
}

/** Al admitir: crea la reserva con el importe de la vía y el plazo configurados. */
export async function crearReserva(tx: Tx, s: Solicitud, via: Via, usuarioId: string, cfg: ReservaConfig, ahora = new Date()) {
  const [r] = await tx
    .insert(reservas)
    .values({
      solicitudId: s.id,
      importe: importeReserva(cfg, via.familia),
      fechaLimite: fechaLocal(sumarDias(ahora, cfg.plazoDias)),
      creadaPorId: usuarioId,
    })
    .returning();
  return r!;
}

/**
 * Anula la reserva vigente al salir de ADMITIDA (cambio de decisión o descartada).
 * Si ya tiene cobros, no se anula sola: primero hay que anular esos cobros (y devolver el dinero).
 */
export async function anularReservaVigente(tx: Tx, solicitudId: string, motivo: string, actor: Actor) {
  const [r] = await tx
    .select()
    .from(reservas)
    .where(and(eq(reservas.solicitudId, solicitudId), inArray(reservas.estado, ['PENDIENTE', 'VENCIDA'])))
    .for('update');
  if (!r) return null;
  const pagado = (await pagadoPorReserva(tx, [r.id])).get(r.id) ?? 0;
  if (pagado > 0) {
    throw conflict('RESERVA_CON_COBROS', `La reserva ya tiene ${euros(pagado)} cobrados. Anula antes esos cobros desde Cobros.`, { reservaId: r.id, pagado });
  }
  await tx.update(reservas).set({ estado: 'ANULADA', anuladaEn: new Date(), motivoAnulacion: motivo }).where(eq(reservas.id, r.id));
  await registrarEvento(tx, solicitudId, actor, 'RESERVA_ANULADA', { detalle: { reservaId: r.id, motivo } });
  return r.id;
}

// ── Control de reservas ─────────────────────────────────────────────────────

const lista = <T extends readonly [string, ...string[]]>(valores: T) =>
  z
    .union([z.enum(valores), z.array(z.enum(valores))])
    .optional()
    .transform((x) => (x === undefined ? undefined : Array.isArray(x) ? x : [x]));

export const listarReservasQuery = z.object({
  /** Sin indicarlo: todas menos las anuladas. */
  estado: lista(estadoReservaEnum.enumValues),
  /** "Reservas por vencer": pendientes a 3 días o menos del plazo, y vencidas. */
  porVencer: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** Alumna, familia o código. */
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export async function listar(q: z.infer<typeof listarReservasQuery>) {
  const hoy = fechaLocal(new Date());
  const c: SQL[] = [q.estado?.length ? inArray(reservas.estado, q.estado) : ne(reservas.estado, 'ANULADA')];
  if (q.porVencer) {
    c.push(
      or(
        eq(reservas.estado, 'VENCIDA'),
        and(eq(reservas.estado, 'PENDIENTE'), lte(reservas.fechaLimite, fechaLocal(sumarDias(new Date(), DIAS_RESERVA_POR_VENCER)))),
      )!,
    );
  }
  if (q.q) {
    const t = `%${q.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    c.push(or(ilike(sql`${solicitudes.alumnaNombre} || ' ' || ${solicitudes.alumnaApellidos}`, t), ilike(solicitudes.tutorNombre, t), ilike(solicitudes.codigo, t))!);
  }
  const where = and(...c);
  const [filas, [total]] = await Promise.all([
    db
      .select({ r: reservas, s: solicitudes, via: vias })
      .from(reservas)
      .innerJoin(solicitudes, eq(solicitudes.id, reservas.solicitudId))
      .innerJoin(vias, eq(vias.id, solicitudes.viaId))
      .where(where)
      .orderBy(asc(reservas.fechaLimite), asc(reservas.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(reservas).innerJoin(solicitudes, eq(solicitudes.id, reservas.solicitudId)).where(where),
  ]);
  const pagado = await pagadoPorReserva(db, filas.map((f) => f.r.id));
  return {
    items: filas.map(({ r, s, via }) => ({
      ...vistaReserva(r, pagado.get(r.id) ?? 0, hoy),
      solicitud: {
        id: s.id,
        codigo: s.codigo,
        estado: s.estado,
        alumna: `${s.alumnaNombre} ${s.alumnaApellidos}`.trim(),
        tutor: s.tutorNombre,
        email: s.email,
        telefono: s.telefono,
        via: { familia: via.familia, curso: via.curso, nombre: via.nombre },
      },
    })),
    page: q.page,
    pageSize: q.pageSize,
    total: total?.n ?? 0,
  };
}

// ── Tareas programadas ──────────────────────────────────────────────────────

/** Un único recordatorio a 3 días (o menos) del vencimiento, a partir de las 10:00 de Madrid. */
export async function recordatoriosPago(ahora = new Date()) {
  const horaMadrid = Number(new Intl.DateTimeFormat('es-ES', { timeZone: env.TZ_CENTRO, hour: '2-digit', hourCycle: 'h23' }).format(ahora));
  if (horaMadrid < 10) return 0;
  const hoy = fechaLocal(ahora);
  const candidatas = await db
    .select({ id: reservas.id })
    .from(reservas)
    .where(
      and(
        eq(reservas.estado, 'PENDIENTE'),
        isNull(reservas.recordatorioEnviadoEn),
        gte(reservas.fechaLimite, hoy),
        lte(reservas.fechaLimite, fechaLocal(sumarDias(ahora, DIAS_RESERVA_POR_VENCER))),
      ),
    );
  if (!candidatas.length) return 0;
  const cfg = await reservaConfig();

  let enviados = 0;
  for (const { id } of candidatas) {
    await db.transaction(async (tx) => {
      // Reclamar: si otra instancia ya lo hizo, no se duplica.
      const [r] = await tx
        .update(reservas)
        .set({ recordatorioEnviadoEn: ahora })
        .where(and(eq(reservas.id, id), isNull(reservas.recordatorioEnviadoEn), eq(reservas.estado, 'PENDIENTE')))
        .returning();
      if (!r) return;
      if (await enviarRecordatorioPago(tx, r, cfg, { tipo: 'sistema' })) enviados++;
    });
  }
  return enviados;
}

async function enviarRecordatorioPago(tx: Tx, r: Reserva, cfg: ReservaConfig, actor: Actor) {
  const { s, via } = await obtenerSolicitud(tx, r.solicitudId);
  const pendiente = r.importe - ((await pagadoPorReserva(tx, [r.id])).get(r.id) ?? 0);
  const enviado = await enviarEvento(tx, 'RECORDATORIO_PAGO', {
    para: s.email,
    vars: { ...datosCorreo(s, via), concepto: 'la reserva de plaza', ...varsPago(cfg, r, pendiente) },
    solicitudId: s.id,
  });
  await registrarEvento(tx, s.id, actor, 'RECORDATORIO_PAGO', { detalle: { reservaId: r.id, enviado, manual: actor.tipo === 'usuario' } });
  return enviado;
}

/** Entre dos recordatorios (manuales o automático) tiene que pasar al menos este tiempo. */
const MIN_ENTRE_RECORDATORIOS_MS = 60 * 60_000;

/**
 * Botón "Recordar" del control de reservas: envía ya el recordatorio de pago.
 * Cuenta como el recordatorio de la reserva: el automático de 3 días no sale si ya se envió uno.
 */
export async function recordar(id: string, usuarioId: string) {
  const cfg = await reservaConfig();
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(reservas).where(eq(reservas.id, id)).for('update');
    if (!r) throw notFound('Reserva no encontrada.', 'RESERVA_NO_ENCONTRADA');
    if (r.estado !== 'PENDIENTE' && r.estado !== 'VENCIDA') {
      throw conflict('RESERVA_NO_PENDIENTE', `La reserva está ${ETIQUETA_ESTADO_RESERVA[r.estado].toLowerCase()}: no hay nada que recordar.`);
    }
    const ahora = new Date();
    if (r.recordatorioEnviadoEn && ahora.getTime() - r.recordatorioEnviadoEn.getTime() < MIN_ENTRE_RECORDATORIOS_MS) {
      throw conflict('RECORDATORIO_RECIENTE', 'Ya se envió un recordatorio hace menos de una hora.', { recordatorioEnviadoEn: r.recordatorioEnviadoEn });
    }
    const enviado = await enviarRecordatorioPago(tx, r, cfg, { tipo: 'usuario', usuarioId });
    if (!enviado) throw conflict('RECORDATORIO_NO_ENVIADO', 'No se ha enviado: la familia no tiene correo o la plantilla «Recordatorio de pago» está en borrador.');
    const [act] = await tx.update(reservas).set({ recordatorioEnviadoEn: ahora }).where(eq(reservas.id, r.id)).returning();
    const pagado = (await pagadoPorReserva(tx, [r.id])).get(r.id) ?? 0;
    return vistaReserva(act!, pagado);
  });
}

/** Pasado el plazo sin pagar: la reserva queda VENCIDA y se avisa a secretaría y administración. */
export async function vencerReservas(ahora = new Date()) {
  const candidatas = await db
    .select({ id: reservas.id })
    .from(reservas)
    .where(and(eq(reservas.estado, 'PENDIENTE'), lt(reservas.fechaLimite, fechaLocal(ahora))));
  const destinatarios = [...new Set([env.MAIL_SECRETARIA, env.MAIL_ADMINISTRACION].filter((x): x is string => !!x))];

  let vencidas = 0;
  for (const { id } of candidatas) {
    await db.transaction(async (tx) => {
      const [r] = await tx
        .update(reservas)
        .set({ estado: 'VENCIDA', vencidaEn: ahora })
        .where(and(eq(reservas.id, id), eq(reservas.estado, 'PENDIENTE')))
        .returning();
      if (!r) return;
      const { s, via } = await obtenerSolicitud(tx, r.solicitudId);
      const pendiente = r.importe - ((await pagadoPorReserva(tx, [r.id])).get(r.id) ?? 0);
      await registrarEvento(tx, s.id, { tipo: 'sistema' }, 'RESERVA_VENCIDA', { detalle: { reservaId: r.id, pendiente } });
      const enlace = `${env.PUBLIC_APP_URL}/admision?ref=${s.codigo}`;
      for (const para of destinatarios) {
        await enviarEvento(tx, 'RESERVA_VENCIDA', {
          para,
          vars: {
            ...datosCorreo(s, via),
            tutor: s.tutorNombre,
            telefono: s.telefono,
            importe: euros(pendiente),
            fecha_limite: fechaTexto(r.fechaLimite),
            enlace,
            boton: boton(enlace, 'Abrir la solicitud'),
          },
          solicitudId: s.id,
        });
      }
      vencidas++;
    });
  }
  if (vencidas) logger.info({ n: vencidas }, 'Reservas vencidas sin pagar');
  return vencidas;
}
