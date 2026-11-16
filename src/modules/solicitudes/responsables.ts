import { and, asc, eq, inArray } from 'drizzle-orm';
import { entrevistadores, solicitudResponsables, usuarios } from '../../db/schema';
import type { Tx } from '../../lib/db';
import { badRequest } from '../../lib/errors';

/**
 * Responsables de una solicitud (16/11/2026): uno o varios, del personal de la plataforma
 * (`usuario`) o de la lista de entrevistadoras de Configuración (`entrevistador`).
 */
export type TipoResponsable = 'usuario' | 'entrevistador';

export interface Responsable {
  tipo: TipoResponsable;
  id: string;
  nombre: string;
}

/** Los responsables de varias solicitudes, en su orden: una consulta para toda la página. */
export async function responsablesDe(tx: Tx, solicitudIds: string[]): Promise<Map<string, Responsable[]>> {
  const porSolicitud = new Map<string, Responsable[]>();
  if (!solicitudIds.length) return porSolicitud;
  const filas = await tx
    .select({
      solicitudId: solicitudResponsables.solicitudId,
      usuarioId: solicitudResponsables.usuarioId,
      entrevistadorId: solicitudResponsables.entrevistadorId,
      usuario: usuarios.nombre,
      entrevistador: entrevistadores.nombre,
    })
    .from(solicitudResponsables)
    .leftJoin(usuarios, eq(usuarios.id, solicitudResponsables.usuarioId))
    .leftJoin(entrevistadores, eq(entrevistadores.id, solicitudResponsables.entrevistadorId))
    .where(inArray(solicitudResponsables.solicitudId, [...new Set(solicitudIds)]))
    .orderBy(asc(solicitudResponsables.orden), asc(solicitudResponsables.id));
  for (const f of filas) {
    const r: Responsable = f.usuarioId
      ? { tipo: 'usuario', id: f.usuarioId, nombre: f.usuario ?? '' }
      : { tipo: 'entrevistador', id: f.entrevistadorId!, nombre: f.entrevistador ?? '' };
    porSolicitud.set(f.solicitudId, [...(porSolicitud.get(f.solicitudId) ?? []), r]);
  }
  return porSolicitud;
}

/**
 * Sustituye los responsables de una solicitud por la lista dada (sin repetidos, en ese orden).
 * Solo personal activo y entrevistadoras activas: si no, 400 RESPONSABLE_NO_VALIDO.
 */
export async function fijarResponsables(tx: Tx, solicitudId: string, lista: { tipo: TipoResponsable; id: string }[]) {
  const unicos = lista.filter((r, i) => lista.findIndex((x) => x.tipo === r.tipo && x.id === r.id) === i);
  const idsUsuario = unicos.filter((r) => r.tipo === 'usuario').map((r) => r.id);
  const idsEntrevistador = unicos.filter((r) => r.tipo === 'entrevistador').map((r) => r.id);
  const validos = [
    ...(idsUsuario.length
      ? await tx.select({ id: usuarios.id }).from(usuarios).where(and(inArray(usuarios.id, idsUsuario), eq(usuarios.activo, true)))
      : []),
    ...(idsEntrevistador.length
      ? await tx
          .select({ id: entrevistadores.id })
          .from(entrevistadores)
          .where(and(inArray(entrevistadores.id, idsEntrevistador), eq(entrevistadores.activo, true)))
      : []),
  ];
  if (validos.length !== unicos.length) throw badRequest('RESPONSABLE_NO_VALIDO', 'Algún responsable no existe o está desactivado.');

  await tx.delete(solicitudResponsables).where(eq(solicitudResponsables.solicitudId, solicitudId));
  if (unicos.length) {
    await tx.insert(solicitudResponsables).values(
      unicos.map((r, orden) => ({
        solicitudId,
        orden,
        usuarioId: r.tipo === 'usuario' ? r.id : null,
        entrevistadorId: r.tipo === 'entrevistador' ? r.id : null,
      })),
    );
  }
  return unicos;
}
