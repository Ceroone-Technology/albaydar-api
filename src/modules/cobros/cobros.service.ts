import { and, count, desc, eq, gte, inArray, isNull, lte, sql, sum, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { cobros, conceptoCobroEnum, metodoPagoEnum, reservas, solicitudes, usuarios, vias, type Cobro } from '../../db/schema';
import { db } from '../../lib/db';
import { euros } from '../../lib/dinero';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { fechaLocal } from '../../lib/fechas';
import { CENTRO } from '../../config/env';
import { escapar } from '../../correo/plantillas';
import { reservaConfig } from '../ajustes/ajustes.service';
import { fechaTexto, pagadoPorReserva, vistaReserva } from '../reservas/reservas.service';
import { cambiarEstado, obtenerSolicitud, registrarEvento, siguienteValor, type Actor } from '../solicitudes/comun';
import { ETIQUETA_CONCEPTO_COBRO, ETIQUETA_METODO_PAGO, cursoEscolarCorto } from '../solicitudes/dominio';

/**
 * Cobros registrados a mano por administración (decisión del cliente: sin importar extractos).
 *  - Cada cobro lleva su recibo de la serie R (R-2026-0001), correlativo por año.
 *  - Cuando lo cobrado cubre la reserva, la reserva pasa a PAGADA y la solicitud a PLAZA_RESERVADA.
 *  - Un cobro no se borra: se anula con motivo, y si la reserva deja de estar cubierta, todo vuelve atrás.
 */

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD.');

export const registrarCobroBody = z.object({
  solicitudId: z.string().uuid(),
  concepto: z.enum(conceptoCobroEnum.enumValues).default('RESERVA_PLAZA'),
  /** En céntimos: 30000 = 300,00 €. */
  importe: z.number().int('En céntimos, sin decimales.').positive('El importe debe ser mayor que 0.').max(10_000_000),
  metodo: z.enum(metodoPagoEnum.enumValues),
  /** Día en que se pagó (no el de registro). Por defecto, hoy. */
  fecha: fecha.optional(),
  observaciones: z.string().trim().max(1000).optional().nullable(),
});

export const anularCobroBody = z.object({
  motivo: z.string().trim().min(1, 'Indica el motivo de la anulación.').max(500),
});

export const listarCobrosQuery = z.object({
  solicitudId: z.string().uuid().optional(),
  concepto: z.enum(conceptoCobroEnum.enumValues).optional(),
  metodo: z.enum(metodoPagoEnum.enumValues).optional(),
  desde: fecha.optional(),
  hasta: fecha.optional(),
  incluirAnulados: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const anulador = alias(usuarios, 'anulador');

function vista(c: Cobro, extra: { registradoPor: string | null; anuladoPor?: string | null }) {
  return {
    id: c.id,
    reciboNumero: c.reciboNumero,
    fecha: c.fecha,
    concepto: c.concepto,
    conceptoEtiqueta: ETIQUETA_CONCEPTO_COBRO[c.concepto],
    importe: c.importe,
    importeTexto: euros(c.importe),
    metodo: c.metodo,
    metodoEtiqueta: ETIQUETA_METODO_PAGO[c.metodo],
    observaciones: c.observaciones,
    registradoPor: c.registradoPorId ? { id: c.registradoPorId, nombre: extra.registradoPor } : null,
    registradoEn: c.createdAt,
    anulado: c.anuladoEn ? { en: c.anuladoEn, motivo: c.motivoAnulacion, por: extra.anuladoPor ?? null } : null,
    solicitudId: c.solicitudId,
    reservaId: c.reservaId,
  };
}

/** "Registrar cobro manual". */
export async function registrar(d: z.infer<typeof registrarCobroBody>, usuarioId: string) {
  const cfg = await reservaConfig();
  if (!cfg.metodos.includes(d.metodo)) throw badRequest('METODO_NO_ADMITIDO', `Forma de pago no admitida: ${ETIQUETA_METODO_PAGO[d.metodo]}.`);
  const hoy = fechaLocal(new Date());
  const fechaPago = d.fecha ?? hoy;
  if (fechaPago > hoy) throw badRequest('FECHA_FUTURA', 'La fecha del cobro no puede ser posterior a hoy.');

  return db.transaction(async (tx) => {
    const { s } = await obtenerSolicitud(tx, d.solicitudId, true);
    const [r] = await tx
      .select()
      .from(reservas)
      .where(and(eq(reservas.solicitudId, s.id), inArray(reservas.estado, ['PENDIENTE', 'VENCIDA'])))
      .for('update');
    if (!r) throw conflict('SIN_RESERVA_PENDIENTE', 'Esta solicitud no tiene una reserva de plaza pendiente de pago.');

    const pagado = (await pagadoPorReserva(tx, [r.id])).get(r.id) ?? 0;
    const pendiente = r.importe - pagado;
    if (d.importe > pendiente) {
      throw badRequest('IMPORTE_SUPERIOR_AL_PENDIENTE', `Quedan ${euros(pendiente)} por pagar: el cobro no puede superarlo.`, { pendiente });
    }

    const recibo = `R-${fechaPago.slice(0, 4)}-${String(await siguienteValor(tx, `recibo-${fechaPago.slice(0, 4)}`)).padStart(4, '0')}`;
    const [c] = await tx
      .insert(cobros)
      .values({
        solicitudId: s.id,
        reservaId: r.id,
        concepto: d.concepto,
        importe: d.importe,
        metodo: d.metodo,
        fecha: fechaPago,
        reciboNumero: recibo,
        registradoPorId: usuarioId,
        observaciones: d.observaciones ?? null,
      })
      .returning();

    const actor: Actor = { tipo: 'usuario', usuarioId };
    await registrarEvento(tx, s.id, actor, 'COBRO_REGISTRADO', { detalle: { cobroId: c!.id, recibo, importe: d.importe, metodo: d.metodo, reservaId: r.id } });

    // Reserva cubierta: pagada y plaza reservada, en la misma transacción.
    let reserva = r;
    if (pagado + d.importe >= r.importe) {
      [reserva] = (await tx.update(reservas).set({ estado: 'PAGADA', pagadaEn: new Date() }).where(eq(reservas.id, r.id)).returning()) as [typeof r];
      if (s.estado === 'ADMITIDA') await cambiarEstado(tx, s, 'PLAZA_RESERVADA', actor, 'PLAZA_RESERVADA', { reservaId: r.id, recibo });
    }
    const [u] = await tx.select({ nombre: usuarios.nombre }).from(usuarios).where(eq(usuarios.id, usuarioId));
    return { cobro: vista(c!, { registradoPor: u?.nombre ?? null }), reserva: vistaReserva(reserva, pagado + d.importe) };
  });
}

/** Anula un cobro (error de registro, devolución). Si la reserva deja de estar cubierta, la plaza vuelve a "Admitida". */
export async function anular(id: string, motivo: string, usuarioId: string) {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(cobros).where(eq(cobros.id, id)).for('update');
    if (!c) throw notFound('Cobro no encontrado.', 'COBRO_NO_ENCONTRADO');
    if (c.anuladoEn) throw conflict('COBRO_YA_ANULADO', 'Este cobro ya está anulado.');
    const { s } = await obtenerSolicitud(tx, c.solicitudId, true);
    if (s.estado === 'MATRICULADA') throw conflict('ALUMNA_MATRICULADA', 'La alumna ya está matriculada: este cobro no se puede anular desde aquí.');

    const [act] = await tx.update(cobros).set({ anuladoEn: new Date(), anuladoPorId: usuarioId, motivoAnulacion: motivo }).where(eq(cobros.id, id)).returning();
    const actor: Actor = { tipo: 'usuario', usuarioId };
    await registrarEvento(tx, s.id, actor, 'COBRO_ANULADO', { detalle: { cobroId: id, recibo: c.reciboNumero, importe: c.importe, motivo } });

    let reserva = null;
    if (c.reservaId) {
      const [r] = await tx.select().from(reservas).where(eq(reservas.id, c.reservaId)).for('update');
      const pagado = (await pagadoPorReserva(tx, [r!.id])).get(r!.id) ?? 0;
      let actual = r!;
      if (r!.estado === 'PAGADA' && pagado < r!.importe) {
        const vencida = r!.fechaLimite < fechaLocal(new Date());
        [actual] = (await tx
          .update(reservas)
          .set({ estado: vencida ? 'VENCIDA' : 'PENDIENTE', pagadaEn: null })
          .where(eq(reservas.id, r!.id))
          .returning()) as [typeof actual];
        if (s.estado === 'PLAZA_RESERVADA') await cambiarEstado(tx, s, 'ADMITIDA', actor, 'RESERVA_REABIERTA', { reservaId: r!.id, cobroId: id });
      }
      reserva = vistaReserva(actual, pagado);
    }
    const nombres = await tx.select({ id: usuarios.id, nombre: usuarios.nombre }).from(usuarios).where(inArray(usuarios.id, [c.registradoPorId, usuarioId]));
    const nombre = (uid: string) => nombres.find((n) => n.id === uid)?.nombre ?? null;
    return { cobro: vista(act!, { registradoPor: nombre(c.registradoPorId), anuladoPor: nombre(usuarioId) }), reserva };
  });
}

export const resumenQuery = z.object({
  /** Solo afectan a "cobrado" (por fecha del pago). Lo pendiente es siempre el actual. */
  desde: fecha.optional(),
  hasta: fecha.optional(),
});

/**
 * KPIs de Cobros:
 *  - cobrado: suma de los cobros no anulados (en el periodo, si se indica);
 *  - pendiente: lo que falta por cobrar de las reservas pendientes o vencidas;
 *  - parcial: reservas con algún pago pero sin completar (familias, cobrado y pendiente).
 */
export async function resumen(q: z.infer<typeof resumenQuery>) {
  const c: SQL[] = [isNull(cobros.anuladoEn)];
  if (q.desde) c.push(gte(cobros.fecha, q.desde));
  if (q.hasta) c.push(lte(cobros.fecha, q.hasta));
  const [[cobrado], abiertas] = await Promise.all([
    db.select({ suma: sum(cobros.importe).mapWith(Number) }).from(cobros).where(and(...c)),
    db.select({ id: reservas.id, importe: reservas.importe }).from(reservas).where(inArray(reservas.estado, ['PENDIENTE', 'VENCIDA'])),
  ]);
  const pagado = await pagadoPorReserva(db, abiertas.map((r) => r.id));
  let pendiente = 0;
  const parcial = { familias: 0, cobrado: 0, pendiente: 0 };
  for (const r of abiertas) {
    const p = pagado.get(r.id) ?? 0;
    pendiente += r.importe - p;
    if (p > 0) {
      parcial.familias++;
      parcial.cobrado += p;
      parcial.pendiente += r.importe - p;
    }
  }
  const total = cobrado?.suma ?? 0;
  return {
    cobrado: total,
    cobradoTexto: euros(total),
    pendiente,
    pendienteTexto: euros(pendiente),
    reservasPendientes: abiertas.length,
    parcial: { ...parcial, cobradoTexto: euros(parcial.cobrado), pendienteTexto: euros(parcial.pendiente) },
  };
}

/**
 * Recibo imprimible (HTML con estilos de impresión: "Imprimir → Guardar como PDF").
 * La enseñanza que imparte un centro autorizado está exenta de IVA (art. 20.Uno.9.º de la Ley 37/1992),
 * y la reserva es un pago a cuenta de esa enseñanza: el recibo va sin IVA.
 */
export async function recibo(id: string) {
  const [f] = await db
    .select({ c: cobros, s: solicitudes, via: vias, registradoPor: usuarios.nombre })
    .from(cobros)
    .innerJoin(solicitudes, eq(solicitudes.id, cobros.solicitudId))
    .innerJoin(vias, eq(vias.id, solicitudes.viaId))
    .leftJoin(usuarios, eq(usuarios.id, cobros.registradoPorId))
    .where(eq(cobros.id, id));
  if (!f) throw notFound('Cobro no encontrado.', 'COBRO_NO_ENCONTRADO');
  const { c, s, via } = f;
  const e = (x: string | null | undefined) => escapar(x ?? '');
  const alumna = `${s.alumnaNombre} ${s.alumnaApellidos}`.trim();
  const fila = (k: string, valor: string) => `<tr><th>${k}</th><td>${valor}</td></tr>`;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Recibo ${e(c.reciboNumero)}</title>
<style>
  body{font:14px/1.55 Arial,sans-serif;color:#1a1d24;margin:0;background:#f5f6f8}
  .hoja{max-width:720px;margin:24px auto;background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:36px 40px;position:relative}
  header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #C2002F;padding-bottom:16px;margin-bottom:24px}
  header img{height:42px} .centro{text-align:right;font-size:12px;color:#5b6270}
  h1{font:700 22px Montserrat,Arial,sans-serif;margin:0 0 4px} .num{color:#9C0026;font-weight:700}
  table{width:100%;border-collapse:collapse;margin:18px 0} th{text-align:left;width:38%;color:#5b6270;font-weight:400;padding:8px 0;border-bottom:1px solid #eef0f3}
  td{padding:8px 0;border-bottom:1px solid #eef0f3} .importe{font:700 26px Arial,sans-serif;margin:18px 0}
  .nota{font-size:12px;color:#5b6270;margin-top:28px} .anulado{border:2px solid #C2002F;color:#C2002F;padding:10px 14px;border-radius:8px;font-weight:700;margin-bottom:18px}
  @media print{body{background:#fff}.hoja{border:0;margin:0;max-width:none;padding:0}}
</style></head><body><div class="hoja">
<header><img src="${CENTRO.logo}" alt="${e(CENTRO.nombre)}"><div class="centro">${e(CENTRO.nombre)}<br>${e(CENTRO.direccion)}<br>${e(CENTRO.telefono)}</div></header>
${c.anuladoEn ? `<div class="anulado">RECIBO ANULADO el ${e(fechaTexto(fechaLocal(c.anuladoEn)))}${c.motivoAnulacion ? ` · ${e(c.motivoAnulacion)}` : ''}</div>` : ''}
<h1>Recibo <span class="num">${e(c.reciboNumero)}</span></h1>
<div>Fecha del pago: ${e(fechaTexto(c.fecha))}</div>
<div class="importe">${e(euros(c.importe))}</div>
<table>
${fila('Recibido de', e(s.tutorNombre))}
${fila('Concepto', `${e(ETIQUETA_CONCEPTO_COBRO[c.concepto])} · ${e(alumna)}`)}
${fila('Plaza', `${e(via.nombre)} · curso ${e(cursoEscolarCorto(via.cursoEscolar))}`)}
${fila('Solicitud', e(s.codigo))}
${fila('Forma de pago', e(ETIQUETA_METODO_PAGO[c.metodo]))}
${c.observaciones ? fila('Observaciones', e(c.observaciones)) : ''}
${fila('Registrado por', e(f.registradoPor))}
</table>
<p class="nota">Operación exenta de IVA (art. 20.Uno.9.º de la Ley 37/1992, del Impuesto sobre el Valor Añadido).</p>
</div></body></html>`;
  return { nombre: `recibo-${c.reciboNumero}.html`, html };
}

/** Pestaña "Pagos": cobros con filtros y la suma de los no anulados. */
export async function listar(q: z.infer<typeof listarCobrosQuery>) {
  const c: SQL[] = [];
  if (q.solicitudId) c.push(eq(cobros.solicitudId, q.solicitudId));
  if (q.concepto) c.push(eq(cobros.concepto, q.concepto));
  if (q.metodo) c.push(eq(cobros.metodo, q.metodo));
  if (q.desde) c.push(gte(cobros.fecha, q.desde));
  if (q.hasta) c.push(lte(cobros.fecha, q.hasta));
  if (!q.incluirAnulados) c.push(isNull(cobros.anuladoEn));
  const where = and(...c);

  const [filas, [totales]] = await Promise.all([
    db
      .select({ c: cobros, registradoPor: usuarios.nombre, anuladoPor: anulador.nombre, s: solicitudes, via: vias })
      .from(cobros)
      .innerJoin(solicitudes, eq(solicitudes.id, cobros.solicitudId))
      .innerJoin(vias, eq(vias.id, solicitudes.viaId))
      .leftJoin(usuarios, eq(usuarios.id, cobros.registradoPorId))
      .leftJoin(anulador, eq(anulador.id, cobros.anuladoPorId))
      .where(where)
      .orderBy(desc(cobros.fecha), desc(cobros.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db
      .select({ n: count(), suma: sum(sql`case when ${cobros.anuladoEn} is null then ${cobros.importe} else 0 end`).mapWith(Number) })
      .from(cobros)
      .where(where),
  ]);
  const suma = totales?.suma ?? 0;
  return {
    items: filas.map(({ c: x, registradoPor, anuladoPor, s, via }) => ({
      ...vista(x, { registradoPor, anuladoPor }),
      solicitud: { id: s.id, codigo: s.codigo, alumna: `${s.alumnaNombre} ${s.alumnaApellidos}`.trim(), via: { familia: via.familia, curso: via.curso, nombre: via.nombre } },
    })),
    page: q.page,
    pageSize: q.pageSize,
    total: totales?.n ?? 0,
    suma,
    sumaTexto: euros(suma),
  };
}
