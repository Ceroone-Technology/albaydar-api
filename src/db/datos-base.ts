import { eq } from 'drizzle-orm';
import { EVENTOS } from '../correo/eventos';
import type { Db } from '../lib/db';
import { AGENDA_POR_DEFECTO, RESERVA_POR_DEFECTO } from '../modules/ajustes/ajustes.service';
import { ROLES_INICIALES } from '../modules/permisos/catalogo';
import { ajustes, plantillasCorreo, roles } from './schema';

/**
 * Datos imprescindibles en cualquier entorno (también en producción):
 * los cuatro roles, una plantilla por evento, el horario de la agenda y la configuración de la reserva.
 * Idempotente: no pisa lo que el centro ya haya cambiado.
 */
export async function sembrarBase(db: Db) {
  for (const r of ROLES_INICIALES) {
    await db
      .insert(roles)
      .values({ ...r, permisos: [...r.permisos] })
      .onConflictDoNothing();
  }

  for (const ev of EVENTOS) {
    const existentes = await db.select().from(plantillasCorreo).where(eq(plantillasCorreo.evento, ev.clave));
    if (!existentes.length) {
      await db.insert(plantillasCorreo).values({
        evento: ev.clave,
        ...ev.predeterminada,
        // Las de fases futuras quedan en borrador; las del flujo actual, activadas.
        estado: ev.disponible ? 'ACTIVADA' : 'BORRADOR',
      });
      continue;
    }
    // Un evento de una fase futura que ya está construido: su plantilla de borrador,
    // si nadie la ha tocado, pasa a la predeterminada actual y se activa.
    const intacta = existentes.length === 1 && existentes[0]!.estado === 'BORRADOR' && existentes[0]!.updatedAt.getTime() === existentes[0]!.createdAt.getTime();
    if (ev.disponible && intacta) {
      await db
        .update(plantillasCorreo)
        .set({ ...ev.predeterminada, estado: 'ACTIVADA' })
        .where(eq(plantillasCorreo.id, existentes[0]!.id));
    }
  }

  await db.insert(ajustes).values({ clave: 'agenda', valor: AGENDA_POR_DEFECTO }).onConflictDoNothing();
  await db.insert(ajustes).values({ clave: 'reserva', valor: RESERVA_POR_DEFECTO }).onConflictDoNothing();
}
