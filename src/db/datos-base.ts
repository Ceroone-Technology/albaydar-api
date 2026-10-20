import { eq } from 'drizzle-orm';
import { EVENTOS } from '../correo/eventos';
import type { Db } from '../lib/db';
import { AGENDA_POR_DEFECTO } from '../modules/ajustes/ajustes.service';
import { ROLES_INICIALES } from '../modules/permisos/catalogo';
import { ajustes, plantillasCorreo, roles } from './schema';

/**
 * Datos imprescindibles en cualquier entorno (también en producción):
 * los cuatro roles, una plantilla por evento y el horario de la agenda.
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
    const [hay] = await db.select({ id: plantillasCorreo.id }).from(plantillasCorreo).where(eq(plantillasCorreo.evento, ev.clave)).limit(1);
    if (hay) continue;
    await db.insert(plantillasCorreo).values({
      evento: ev.clave,
      ...ev.predeterminada,
      // Las de fases futuras quedan en borrador; las del flujo actual, activadas.
      estado: ev.disponible ? 'ACTIVADA' : 'BORRADOR',
    });
  }

  await db.insert(ajustes).values({ clave: 'agenda', valor: AGENDA_POR_DEFECTO }).onConflictDoNothing();
}
