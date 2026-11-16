import { eq } from 'drizzle-orm';
import { EVENTOS } from '../correo/eventos';
import type { Db } from '../lib/db';
import { AGENDA_POR_DEFECTO, RESERVA_POR_DEFECTO } from '../modules/ajustes/ajustes.service';
import { ROLES_INICIALES } from '../modules/permisos/catalogo';
import { ajustes, plantillasCorreo, roles } from './schema';

/**
 * Datos imprescindibles en cualquier entorno (también en producción):
 * los cuatro roles, una plantilla por evento, el horario de la agenda y la configuración de la reserva.
 * Idempotente: no pisa lo que el centro ya haya cambiado; lo que nadie ha tocado sigue a la versión actual.
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
    // Una plantilla que nadie ha editado (sin actualizadoPorId: la creó la semilla) sigue a la
    // predeterminada actual: así los cambios de texto llegan también a las BD ya creadas.
    // Si es de un evento de una fase futura que ya está construido, además se activa.
    // Si el centro la tocó (o creó otra para el evento), no se cambia nada.
    const unica = existentes.length === 1 ? existentes[0]! : null;
    if (!unica || unica.actualizadoPorId !== null) continue;
    const activar = ev.disponible && unica.estado === 'BORRADOR';
    const { nombre, asunto, cuerpoHtml } = ev.predeterminada;
    const desfasada = unica.nombre !== nombre || unica.asunto !== asunto || unica.cuerpoHtml !== cuerpoHtml;
    if (activar || desfasada) {
      await db
        .update(plantillasCorreo)
        .set({ nombre, asunto, cuerpoHtml, ...(activar ? { estado: 'ACTIVADA' as const } : {}) })
        .where(eq(plantillasCorreo.id, unica.id));
    }
  }

  await db.insert(ajustes).values({ clave: 'agenda', valor: AGENDA_POR_DEFECTO }).onConflictDoNothing();
  await db.insert(ajustes).values({ clave: 'reserva', valor: RESERVA_POR_DEFECTO }).onConflictDoNothing();
}
