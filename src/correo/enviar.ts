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
  const ev = evento(clave);
  if (!ev) throw new Error(`Evento de correo desconocido: ${clave}`);
  if (!o.para) return false;

  const [activa] = await tx
    .select()
    .from(plantillasCorreo)
    .where(and(eq(plantillasCorreo.evento, clave), eq(plantillasCorreo.estado, 'ACTIVADA')))
    .limit(1);

  if (!activa && !ev.obligatorio) {
    logger.info({ evento: clave }, 'Plantilla en borrador: no se envía el correo');
    return false;
  }
  if (!activa) logger.warn({ evento: clave }, 'Sin plantilla activada: se usa la predeterminada');

  const fuente = activa ?? ev.predeterminada;
  const correo = renderizar({ evento: clave, asunto: fuente.asunto, cuerpoHtml: fuente.cuerpoHtml, vars: { ...COMUNES, ...o.vars } });
  await encolarCorreo(tx, { plantilla: clave, plantillaId: activa?.id ?? null, para: o.para, correo, solicitudId: o.solicitudId, adjuntos: o.adjuntos });
  return true;
}

export { COMUNES as VARS_COMUNES };
