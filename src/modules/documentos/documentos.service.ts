import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { documentos, type Solicitud } from '../../db/schema';
import { db } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import { sha256 } from '../../lib/crypto';
import { almacen, tipoReal } from '../../lib/storage';
import { registrarEvento } from '../solicitudes/comun';

/** Sube (o reemplaza) el boletín de notas desde el enlace de la cita. */
export async function subirNotas(s: Solicitud, f: { buffer: Buffer; originalname: string; size: number }) {
  const tipo = tipoReal(f.buffer);
  if (!tipo) throw badRequest('TIPO_NO_PERMITIDO', 'Sube un PDF o una foto (JPG, PNG o HEIC).');
  const id = randomUUID();
  const clave = `solicitudes/${s.id}/${id}.${tipo.ext}`;
  await almacen.guardar(clave, f.buffer);
  const nombre = f.originalname.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 150) || `boletin-notas.${tipo.ext}`;

  try {
    return await db.transaction(async (tx) => {
      // Reemplazar: el anterior queda marcado como eliminado (se conserva el registro).
      await tx
        .update(documentos)
        .set({ eliminadoEn: new Date() })
        .where(and(eq(documentos.solicitudId, s.id), eq(documentos.tipo, 'BOLETIN_NOTAS'), isNull(documentos.eliminadoEn)));
      const [d] = await tx
        .insert(documentos)
        .values({ id, solicitudId: s.id, tipo: 'BOLETIN_NOTAS', nombreOriginal: nombre, mime: tipo.mime, tamano: f.size, clave, sha256: sha256(f.buffer) })
        .returning();
      await registrarEvento(tx, s.id, { tipo: 'familia' }, 'NOTAS_SUBIDAS', { detalle: { documentoId: id, nombre, tamano: f.size } });
      return { nombre: d!.nombreOriginal, tamano: d!.tamano, subidoEn: d!.createdAt };
    });
  } catch (e) {
    await almacen.borrar(clave);
    throw e;
  }
}

export async function quitarNotas(s: Solicitud) {
  await db.transaction(async (tx) => {
    const r = await tx
      .update(documentos)
      .set({ eliminadoEn: new Date() })
      .where(and(eq(documentos.solicitudId, s.id), eq(documentos.tipo, 'BOLETIN_NOTAS'), isNull(documentos.eliminadoEn)))
      .returning({ id: documentos.id });
    if (r.length) await registrarEvento(tx, s.id, { tipo: 'familia' }, 'NOTAS_QUITADAS', { detalle: { documentoId: r[0]!.id } });
  });
}

/** Descarga interna (secretaría / equipo directivo). */
export async function descargar(solicitudId: string, documentoId: string) {
  const [d] = await db
    .select()
    .from(documentos)
    .where(and(eq(documentos.id, documentoId), eq(documentos.solicitudId, solicitudId)))
    .limit(1);
  if (!d) throw notFound('Documento no encontrado.');
  return { doc: d, datos: await almacen.leer(d.clave) };
}
