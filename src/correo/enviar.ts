import { and, eq } from 'drizzle-orm';
import { CENTRO } from '../config/env';
import { plantillasCorreo } from '../db/schema';
import type { Tx } from '../lib/db';
import { logger } from '../lib/logger';
import { evento } from './eventos';
import { encolarCorreo, type Adjunto } from './outbox';
import { renderizar, type Vars } from './plantillas';

const COMUNES: Vars = {
  centro_nombre: CENTRO.nombre,
  centro_direccion: CENTRO.direccion,
  centro_telefono: CENTRO.telefono,
};

/**
 * El correo de un evento tal como saldría, sin encolarlo (también para la vista previa con datos reales).
 *  - Con plantilla ACTIVADA, esa.
 *  - Sin ella: la predeterminada. `seEnvia` es false salvo en los eventos obligatorios
 *    (llevan el enlace de la familia), que se envían igual para no romper el flujo.
 */
export async function prepararEvento(tx: Tx, clave: string, vars: Vars) {
  const ev = evento(clave);
  if (!ev) throw new Error(`Evento de correo desconocido: ${clave}`);
  const [activa] = await tx
    .select()
    .from(plantillasCorreo)
    .where(and(eq(plantillasCorreo.evento, clave), eq(plantillasCorreo.estado, 'ACTIVADA')))
    .limit(1);
  const fuente = activa ?? ev.predeterminada;
  const correo = renderizar({ evento: clave, asunto: fuente.asunto, cuerpoHtml: fuente.cuerpoHtml, vars: { ...COMUNES, ...vars } });
  return { correo, plantillaId: activa?.id ?? null, seEnvia: !!activa || ev.obligatorio };
}

/**
 * Envía (encola) el correo de un evento con la plantilla ACTIVADA en Comunicaciones.
 *  - Sin plantilla activada: los eventos obligatorios (llevan el enlace de la familia)
 *    usan la predeterminada para no romper el flujo; el resto no se envía.
 * Devuelve false si no se envió.
 */
export async function enviarEvento(
  tx: Tx,
  clave: string,
  o: { para: string; vars: Vars; solicitudId?: string; adjuntos?: Adjunto[] },
): Promise<boolean> {
  if (!evento(clave)) throw new Error(`Evento de correo desconocido: ${clave}`);
  if (!o.para) return false;

  const { correo, plantillaId, seEnvia } = await prepararEvento(tx, clave, o.vars);
  if (!seEnvia) {
    logger.info({ evento: clave }, 'Plantilla en borrador: no se envía el correo');
    return false;
  }
  if (!plantillaId) logger.warn({ evento: clave }, 'Sin plantilla activada: se usa la predeterminada');
  await encolarCorreo(tx, { plantilla: clave, plantillaId, para: o.para, correo, solicitudId: o.solicitudId, adjuntos: o.adjuntos });
  return true;
}

export { COMUNES as VARS_COMUNES };
