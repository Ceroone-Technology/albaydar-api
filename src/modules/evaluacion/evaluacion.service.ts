import { and, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { solicitudes, type Reserva, type Solicitud, type Via } from '../../db/schema';
import { db } from '../../lib/db';
import { conflict } from '../../lib/errors';
import { fechaLocal, sumarDias } from '../../lib/fechas';
import { enviarEvento, prepararEvento } from '../../correo/enviar';
import type { Vars } from '../../correo/plantillas';
import { importeReserva, reservaConfig, type ReservaConfig } from '../ajustes/ajustes.service';
import { anularReservaVigente, crearReserva, varsPago, vistaReserva } from '../reservas/reservas.service';
import { cambiarEstado, datosCorreo, obtenerSolicitud, posicionesEnEspera, type Actor } from '../solicitudes/comun';
import { ETIQUETA_ESTADO, cursoEscolarCorto, puedeTransicionar } from '../solicitudes/dominio';

/**
 * "Registrar decisión y notificar" (Evaluación y reserva). Solo Dirección por defecto (evaluacion.editar).
 *  - ADMITIDA: crea la reserva de plaza (importe y plazo de ajustes.reserva) y, si se notifica,
 *    envía el correo con importe, IBAN y fecha límite.
 *  - EN_ESPERA: entra al final de la lista de espera de su vía; el correo lleva la posición.
 *  - NO_ADMITIDA: el correo lleva el motivo, si se indica.
 * Salir de ADMITIDA (a EN_ESPERA) anula la reserva pendiente.
 */
export const decisionBody = z.object({
  decision: z.enum(['ADMITIDA', 'EN_ESPERA', 'NO_ADMITIDA']),
  /** "Enviar el email al guardar la decisión". */
  notificar: z.boolean().default(true),
  /** Para la familia (no admitida o lista de espera). Queda también en el historial. */
  motivo: z.string().trim().max(1000).optional().nullable(),
});

export const previaDecisionBody = decisionBody.pick({ decision: true, motivo: true });

type Decision = z.infer<typeof decisionBody>['decision'];

function comprobarTransicion(s: Solicitud, decision: Decision) {
  if (!puedeTransicionar(s.estado, decision)) {
    throw conflict('TRANSICION_NO_PERMITIDA', `No se puede pasar de “${ETIQUETA_ESTADO[s.estado]}” a “${ETIQUETA_ESTADO[decision]}”.`);
  }
}

/** Variables del correo de la decisión: las mismas para el envío y para la vista previa. */
function varsDecision(
  s: Solicitud,
  via: Via,
  o: { decision: Decision; motivo: string | null; cfg: ReservaConfig; reserva: Pick<Reserva, 'fechaLimite' | 'importe'> | null; posicion: number | null },
): Vars {
  const base = { ...datosCorreo(s, via), etapa: via.nombre, curso_escolar: cursoEscolarCorto(via.cursoEscolar) };
  if (o.decision === 'ADMITIDA') return { ...base, ...varsPago(o.cfg, o.reserva!, o.reserva!.importe), plazo_dias: o.cfg.plazoDias };
  if (o.decision === 'EN_ESPERA') return { ...base, posicion: o.posicion ?? '', motivo: o.motivo ?? '' };
  return { ...base, motivo: o.motivo ?? '' };
}

export async function decidir(id: string, d: z.infer<typeof decisionBody>, usuarioId: string) {
  const cfg = await reservaConfig();
  return db.transaction(async (tx) => {
    const { s, via } = await obtenerSolicitud(tx, id, true);
    comprobarTransicion(s, d.decision);
    const actor: Actor = { tipo: 'usuario', usuarioId };
    const motivo = d.motivo?.trim() || null;

    if (s.estado === 'ADMITIDA') await anularReservaVigente(tx, s.id, `Cambio de decisión: ${ETIQUETA_ESTADO[d.decision]}`, actor);
    if (d.decision === 'EN_ESPERA') await tx.update(solicitudes).set({ enEsperaDesde: new Date() }).where(eq(solicitudes.id, s.id));
    await cambiarEstado(tx, s, d.decision, actor, 'DECISION_REGISTRADA', { decision: d.decision, motivo, notificar: d.notificar });

    const reserva = d.decision === 'ADMITIDA' ? await crearReserva(tx, s, via, usuarioId, cfg) : null;
    const posicion = d.decision === 'EN_ESPERA' ? ((await posicionesEnEspera(tx, [via.id])).get(s.id) ?? null) : null;

    const notificada = d.notificar
      ? await enviarEvento(tx, d.decision, { para: s.email, vars: varsDecision(s, via, { decision: d.decision, motivo, cfg, reserva, posicion }), solicitudId: s.id })
      : false;

    return {
      estado: d.decision,
      estadoEtiqueta: ETIQUETA_ESTADO[d.decision],
      reserva: reserva ? vistaReserva(reserva, 0) : null,
      posicionEspera: posicion,
      /** false si no se pidió, la solicitud no tiene correo o la plantilla está en borrador. */
      notificada,
    };
  });
}

/**
 * "Comunicación automática" del panel: el correo que recibiría la familia con sus datos reales
 * (importe de su vía, IBAN, fecha límite si se decide hoy, posición en la lista). No cambia nada.
 */
export async function previsualizar(id: string, d: z.infer<typeof previaDecisionBody>) {
  const cfg = await reservaConfig();
  const { s, via } = await obtenerSolicitud(db, id);
  comprobarTransicion(s, d.decision);
  const motivo = d.motivo?.trim() || null;

  const reserva = d.decision === 'ADMITIDA' ? { importe: importeReserva(cfg, via.familia), fechaLimite: fechaLocal(sumarDias(new Date(), cfg.plazoDias)) } : null;
  let posicion: number | null = null;
  if (d.decision === 'EN_ESPERA') {
    // Entraría al final de la lista de su vía.
    const [r] = await db.select({ n: count() }).from(solicitudes).where(and(eq(solicitudes.estado, 'EN_ESPERA'), eq(solicitudes.viaId, via.id)));
    posicion = (r?.n ?? 0) + 1;
  }

  const { correo, seEnvia } = await prepararEvento(db, d.decision, varsDecision(s, via, { decision: d.decision, motivo, cfg, reserva, posicion }));
  return {
    para: s.email || null,
    /** false si la solicitud no tiene correo o la plantilla del evento está en borrador. */
    seEnviaria: seEnvia && !!s.email,
    ...correo,
  };
}
